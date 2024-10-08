const { DeezerAPI } = require('./deezer');
const Datastore = require('nedb');
const { Settings } = require('./settings');
const fs = require('fs');
const https = require('https');
const logger = require('./winston');
const path = require('path');
const decryptor = require('nodeezcryptor');
const sanitize = require('sanitize-filename');
const ID3Writer = require('browser-id3-writer');
const Metaflac = require('metaflac-js2');
const { Track, Lyrics, DeezerImage } = require('./definitions');
const { existsSync } = require('original-fs');

let deezer;
let settings;

class DownloadManager {

    constructor(settings, callback) {
        this.settings = settings;
        this.downloading = false;
        this.callback = callback;

        this.queue = [];
        this.threads = [];

        this.updateRequests = 0;
    }

    //Update DeezerAPI global
    setDeezer(d) {
        deezer = d;
    }

    async load() {
        this.db = new Datastore({ filename: Settings.getDownloadsDB(), autoload: true });

        //Load from DB
        await new Promise((resolve) => {
            this.db.find({ state: 0 }, (err, docs) => {
                if (!err) {
                    this.queue = docs.map(d => Download.fromDB(d));
                }
                resolve();
            });
        });

        //Create temp dir
        if (!fs.existsSync(Settings.getTempDownloads())) {
            fs.promises.mkdir(Settings.getTempDownloads(), { recursive: true });
        }
    }

    async start() {
        this.downloading = true;
        await this.updateQueue();
    }

    async stop() {
        this.downloading = false;
        //Stop all threads
        let nThreads = this.threads.length;
        for (let i = nThreads - 1; i >= 0; i--) {
            await this.threads[i].stop();
        }
        this.updateQueue();
    }

    //data: {tracks: [], quality, playlistName}
    async addBatch(data) {
        for (let track of data.tracks) {
            let p = this.settings.downloadsPath;
            if (data.playlistName && this.settings.playlistFolder) {
                p = path.join(p, sanitize(data.playlistName));
            }
            await this.add(track, data.quality, p);
        }
    }

    async add(track, quality, p) {
        //Sanitize quality
        let q = this.settings.downloadsQuality;
        if (quality)
            q = parseInt(quality.toString(), 10);
        let download = new Download(track, q, 0, p);

        if (this.settings.overwritedownloadedfiles) {
            //Check if in queue
            if (this.queue.some(d => d.track.id == track.id)) {
                return;
            }
        }

        //Check if in DB
        let dbDownload = await new Promise((resolve) => {
            this.db.find({ _id: download.track.id }, (err, docs) => {
                if (err) return resolve(null);
                if (docs.length == 0) return resolve(null);

                //Update download as not done, will be skipped while downloading
                this.db.update({ _id: download.track.id }, { state: 0, quality: download.quality }, {}, () => {
                    resolve(Download.fromDB(docs[0]));
                });
            });
        });

        //Insert to DB
        if (!dbDownload) {
            await new Promise((resolve) => {
                this.db.insert(download.toDB(), () => {
                    resolve();
                });
            });
        }

        //Queue
        this.queue.push(download);
        this.updateQueue();
    }

    async delete(index) {
        //-1 = Delete all
        if (index == -1) {
            let ids = this.queue.map(q => q.track.id);
            this.queue = [];
            //Remove from DB
            await new Promise((res) => {
                this.db.remove({ _id: { $in: ids } }, { multi: true }, () => {
                    res();
                })
            });
            this.updateQueue();
            return;
        }

        //Remove single item
        let id = this.queue[index].track.id;
        this.queue.splice(index, 1);
        await new Promise((res) => {
            this.db.remove({ _id: id }, {}, () => {
                res();
            })
        })
        this.updateQueue();
    }

    //Thread safe update
    async updateQueue() {
        this.updateRequests++;
        if (this._updatePromise) return;
        this._updatePromise = this._updateQueue();
        await this._updatePromise;
        this._updatePromise = null;
        this.updateRequests--;
        if (this.updateRequests > 0) {
            this.updateRequests--;
            this.updateQueue();
        }
    }

    async _updateQueue() {
        //Finished downloads
        if (this.threads.length > 0) {
            for (let i = this.threads.length - 1; i >= 0; i--) {
                if (this.threads[i].download.state == 3 || this.threads[i].download.state == -1) {
                    //Update DB
                    await new Promise((resolve) => {
                        this.db.update({ _id: this.threads[i].download.track.id }, { state: this.threads[i].download.state }, {}, () => {
                            resolve();
                        });
                    });
                    this.threads.splice(i, 1);
                } else {
                    //Remove if stopped
                    if (this.threads[i].stopped) {
                        this.queue.unshift(this.threads[i].download);
                        this.threads.splice(i, 1);
                    }
                }
            }
        }
        //Create new threads
        if (this.downloading) {
            let nThreads = this.settings.downloadThreads - this.threads.length;
            for (let i = 0; i < nThreads; i++) {
                if (this.queue.length > 0) {
                    let thread = new DownloadThread(this.queue[0], () => { this.updateQueue(); }, this.settings);
                    thread.start();
                    this.threads.push(thread);
                    this.queue.splice(0, 1);
                }
            }
        }
        //Stop downloading if queues empty
        if (this.queue.length == 0 && this.threads.length == 0 && this.downloading)
            this.downloading = false;

        //Update UI
        if (this.callback)
            this.callback();
    }
}

class DownloadThread {
    constructor(download, callback, settings) {
        this.download = download;
        this.callback = callback;
        this.settings = settings;
        this.stopped = true;
        this.isUserUploaded = download.track.id.toString().startsWith('-');
        this.coverPath = null;
        this.encrypted = false;
    }

    //Callback wrapper
    _cb() {
        if (this.callback) this.callback();
    }

    async start() {
        this.download.state = 1;
        this.stopped = false;

        //Fallback
        this.qualityInfo = await deezer.fallback(this.download.track.streamUrl, this.download.quality);
        if (!this.qualityInfo) {
            this.download.state = -1;
            this._cb();
            return;
        }

        //Get track info
        if (!this.isUserUploaded) {
            try {
                this.rawTrack = await deezer.callApi('deezer.pageTrack', { 'sng_id': this.qualityInfo.trackId });
                console.warn(this.rawTrack);
                this.track = new Track(this.rawTrack.results.DATA);
                this.publicTrack = await deezer.callPublicApi('track', this.track.id);
                console.warn(this.publicTrack);
                this.publicAlbum = await deezer.callPublicApi('album', this.track.album.id);
                console.warn(this.publicAlbum);
            } catch (e) {
                logger.error(`Error fetching metadata for ID: ${this.qualityInfo.trackId}, Error: ${e}`);
                this.download.state = -1;
                this._cb();
                return;
            }
        }

        //Check if exists
        let outPath = this.generatePath(this.qualityInfo.quality);
        try {
            await fs.promises.access(outPath, fs.constants.R_OK);
            //File exists
            this.download.state = 3;
            return this._cb();
        } catch (_) {}

        //Path to temp file
        let tmp = path.join(Settings.getTempDownloads(), `${this.download.track.id}.ENC`);
        //Get start offset
        let start = 0;
        try {
            let stat = await fs.promises.stat(tmp);
            if (stat.size) start = stat.size;

            // eslint-disable-next-line no-empty
        } catch (e) {}
        this.download.downloaded = start;

        //Download
        let urlGen = await deezer.generateUrl(this.qualityInfo.trackId, this.qualityInfo.md5origin, this.qualityInfo.mediaVersion, this.qualityInfo.quality);
        this.encrypted = urlGen.encrypted;

        if (this.stopped) return;
        this._request = https.get(urlGen.url, { headers: { 'Range': `bytes=${start}-` } }, (r) => {
            this._response = r;
            let outFile = fs.createWriteStream(tmp, { flags: 'a' });

            //On download done
            r.on('end', () => {
                if (this.download.size != this.download.downloaded) return;

                outFile.on('finish', () => {
                    outFile.close(() => {
                        this.postPromise = this._post(tmp);
                    });
                });
                outFile.end();
            });
            //Progress
            r.on('data', (c) => {
                outFile.write(c);
                this.download.downloaded += c.length;
            });

            r.on('error', (e) => {
                logger.error(`Download error: ${e}`);
                //TODO: Download error handling
            })

            //Save size
            this.size = parseInt(r.headers['content-length'], 10) + start;
            this.download.size = this.size;
        });
    }

    async stop() {
        //If post processing, wait for it
        if (this.postPromise) {
            await this._postPromise;
            return this._cb();
        }

        //Cancel download
        if (this._response)
            this._response.destroy();
        if (this._request)
            this._request.destroy();

        // this._response = null;
        // this._request = null;

        this.stopped = true;
        this.download.state = 0;
        this._cb();
    }

    async _post(tmp) {
        this.download.state = 2;

        //Decrypt
        let outPath = this.generatePath(this.qualityInfo.quality);
        //File Already Exists
        if (!existsSync(fs.outPath)) {} else {
            if (settings.overwriteDownload) {
                outPath.delete();
            } else {
                this.download.state = 3;
                this._cb();
                return;
            }
        }

        await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
        if (this.encrypted) {
            decryptor.decryptFile(decryptor.getKey(this.qualityInfo.trackId), tmp, `${tmp}.DEC`);
            await fs.promises.copyFile(`${tmp}.DEC`, outPath);
            await fs.promises.unlink(`${tmp}.DEC`);
        } else {
            await fs.promises.copyFile(tmp, outPath);
        }
        await fs.promises.unlink(tmp);


        let cover = null;

        if (!this.isUserUploaded) {
            //Tag, returns cover to prevent double downlaoding
            cover = await this.tagTrack(outPath);

            //Lyrics
            if (this.settings.downloadLyrics) {
                let lrcFile = outPath.split('.').slice(0, -1).join('.') + '.lrc';
                let lrc;
                try {
                    lrc = this.generateLRC();
                } catch (e) {
                    logger.warn('Error getting lyrics! ' + e);
                }
                if (!fs.existsSync(lrcFile)) {
                    if (lrc) {
                        await fs.promises.writeFile(lrcFile, lrc, { encoding: 'utf-8' });
                    }
                } else {
                    if (this.settings.overwriteDownload) {
                        if (lrc) {
                            await fs.promises.writeFile(lrcFile, lrc, { encoding: 'utf-8' });
                        }
                    }
                }
            }
        }

        //Cover
        if (this.settings.downloadCover) {
            if (this.coverPath) {
                if (!existsSync(this.coverPath)) {
                    //Create empty file to "lock"
                    fs.closeSync(fs.openSync(this.coverPath, 'w'));
                    if (!cover) {
                        try {
                            cover = await this.downloadCover(DeezerImage.url(this.track.albumArt.hash, 'cover', this.settings.coverResolution));
                        } catch (e) {}
                    }
                    if (this.settings.c)
                        if (existsSync(coverPath)) {
                            if (!cover) {
                                logger.warn("Error downloading album art!");
                            } else {
                                await fs.promises.writeFile(this.coverPath, cover);
                            }
                        } else {
                            if (this.settings.overwriteDownload) {
                                if (!cover) {
                                    logger.warn("Error downloading album art!");
                                } else {
                                    await fs.promises.writeFile(this.coverPath, cover);
                                }
                            }
                        }
                }
            }
        }


        this.download.state = 3;
        this._cb();
    }

    async tagTrack(path) {
        let cover;
        try {
            cover = await this.downloadCover(DeezerImage.url(this.track.albumArt.hash, 'cover', this.settings.coverResolution), 'cover', this.settings.coverResolution);
        } catch (e) {}

        // Genre tag
        let genres = [];
        if (this.publicAlbum.genres && this.publicAlbum.genres.data) {
            genres = this.publicAlbum.genres.data.map(g => g.name);
        }

        if (path.toLowerCase().endsWith('.mp3')) {
            // Load
            const audioData = await fs.promises.readFile(path);
            const writer = new ID3Writer(audioData);

            // Title
            if (this.settings.title) writer.setFrame('TIT2', this.track.title);

            // Artists
            const artists = this.track.artists.map(a => a.name).filter(Boolean);
            if (artists.length > 0 && this.settings.artist) {
                writer.setFrame('TPE1', artists);
            }

            // Album Artist
            if (this.publicAlbum.artist && this.settings.albumArtist) {
                writer.setFrame('TPE2', this.publicAlbum.artist.name);
            }

            // Album
            if (this.settings.album) writer.setFrame('TALB', this.track.album.title);

            // Track and Disk Number
            if (this.track.trackNumber && this.settings.trackNumber) {
                writer.setFrame('TRCK', this.track.trackNumber);
            }
            if (this.track.diskNumber && this.settings.discNumber) {
                writer.setFrame('TPOS', this.track.diskNumber);
            }

            // Genre
            if (genres.length > 0 && this.settings.genre) {
                writer.setFrame('TCON', genres);
            }

            // Release Date
            const date = new Date(this.publicTrack.release_date);
            if (this.settings.year) writer.setFrame('TYER', date.getFullYear());
            if (this.settings.releaseDate) {
                writer.setFrame('TDAT', `${date.getMonth().toString().padStart(2, '0')}${date.getDate().toString().padStart(2, '0')}`);
            }

            // BPM
            if (this.publicTrack.bpm > 2 && this.settings.bpm) {
                writer.setFrame('TBPM', this.publicTrack.bpm);
            }

            // Label
            if (this.publicAlbum.label && this.settings.label) {
                writer.setFrame('TPUB', this.publicAlbum.label);
            }

            // ISRC
            if (this.publicTrack.isrc && this.settings.isrc) {
                writer.setFrame('TSRC', this.publicTrack.isrc);
            }

            // Lyrics
            if (this.rawTrack.results.LYRICS && this.settings.lyrics) {
                writer.setFrame('USLT', {
                    lyrics: this.rawTrack.results.LYRICS.LYRICS_TEXT,
                    language: 'eng',
                    description: 'Unsychronised lyrics'
                });
            }

            // Cover Art
            if (cover && this.settings.cover) {
                writer.setFrame('APIC', { type: 3, data: cover, description: 'Cover' });
            }

            writer.addTag();

            // Write
            await fs.promises.writeFile(path, Buffer.from(writer.arrayBuffer));

            return cover;
        }

        //Tag FLAC
        if (path.toLowerCase().endsWith('.flac')) {
            const flac = new Metaflac(path);
            flac.removeAllTags();
            if (this.settings.length) flac.setTag(`LENGTH=${parseInt(this.track.duration)*1000}`)
            if (this.settings.title) flac.setTag(`TITLE=${this.track.title}`);
            if (this.settings.album) flac.setTag(`ALBUM=${this.track.album.title}`);
            if (this.settings.artist && this.publicTrack.contributors) {
                let artists = this.publicTrack.contributors
                    .map(contributor => contributor.name)
                    .filter((artist, index, self) => self.indexOf(artist) === index) // Remove duplicates
                    .join(this.settings.artistSeparator);

                if (artists) {
                    flac.setTag(`ARTIST=${artists}`);
                }
            }
            if (this.settings.trackNumber) flac.setTag(`TRACKNUMBER=${this.track.trackNumber}`);
            if (this.settings.discNumber) flac.setTag(`DISCNUMBER=${this.track.diskNumber}`);
            if (this.settings.barcode) flac.setTag(`BARCODE=${this.publicAlbum.upc}`)
            if (this.track.copyright & this.settings.copyright) flac.setTag(`COPYRIGHT=${this.track.copyright}`);
            if (this.publicAlbum.artist & this.settings.albumArtist) flac.setTag(`ALBUMARTIST=${this.publicAlbum.artist.name}`);
            if (this.settings.genre) flac.setTag(`GENRE=${genres.join(", ")}`);
            if (this.publicTrack.bpm > 2 & this.settings.bpm) flac.setTag(`BPM=${this.publicTrack.bpm}`);
            if (this.publicAlbum.label & this.settings.label) flac.setTag(`LABEL=${this.publicAlbum.label}`);
            if (this.settings.irsc) flac.setTag(`ISRC=${this.publicTrack.isrc}`);
            if (this.publicAlbum.upc & this.settings.barcode) flac.setTag(`BARCODE=${this.publicAlbum.upc}`);
            if (this.rawTrack.results.LYRICS & this.settings.lyrics) flac.setTag(`LYRICS=${this.rawTrack.results.LYRICS.LYRICS_TEXT}`);
            if (this.settings.replayGain) flac.setTag(`REPLAYGAIN_TRACK_GAIN=${Math.round((parseFloat(this.publicTrack.gain) + 18.4)*-100)/100} dB`);
            if (this.settings.savePlaylistAsCompilation && this.track.playlist || this.publicAlbum.recordType == "compile");
            if (this.settings.albumArtist && this.publicAlbum.contributors.length) { if (this.settings.singleAlbumArtist && this.publicAlbum.artist.name) { flac.setTag(`ALBUMARTIST=${this.publicAlbum.artist.name}`) } else { this.publicAlbum.contributors.forEach(artist => { flac.setTag(`ALBUMARTIST=${artist.name}`) }) } };
            if (this.settings.involvedPeople) {
                try {
                    if (this.privateJson && this.privateJson.SNG_CONTRIBUTORS) {
                        const contrib = this.privateJson.SNG_CONTRIBUTORS;

                        const setContributorTag = (key, fieldName) => {
                            if (contrib[key]) {
                                let contributorString = contrib[key]
                                    .map(contributor => contributor.trim())
                                    .filter(contributor => contributor)
                                    .join(settings.artistSeparator);

                                if (contributorString) {
                                    flac.setTag(`${fieldName}=${contributorString}`);
                                }
                            }
                        };
                        // Composer
                        setContributorTag('composer', 'COMPOSER');
                        // Engineer
                        setContributorTag('engineer', 'ENGINEER');
                        // Mixer
                        setContributorTag('mixer', 'MIXER');
                        // Producer
                        setContributorTag('producer', 'PRODUCER');
                        // Author (FLAC specific)
                        setContributorTag('author', 'AUTHOR');
                        // Writer (FLAC specific)
                        setContributorTag('writer', 'WRITER');
                    }
                } catch (error) {
                    console.error('Error setting contributor tags:', error);
                }
            };
            if (this.settings.date) flac.setTag(`DATE=${this.publicTrack.release_date}`);
            else if (this.settings.year) flac.setTag(`DATE=${this.publicTrack.release_date.substring(0, 4)}`);
            if (this.settings.copyright && this.track.copyright) flac.setTag(`COPYRIGHT=${this.track.copyright}`);
            if (this.settings.label) flac.setTag(`PUBLISHER=${this.publicAlbum.label}`);
            if (this.settings.genre && this.publicAlbum.genres && this.publicAlbum.genres.data) {
                try {
                    this.publicAlbum.genres.data.forEach(genreObj => {
                        if (genreObj && genreObj.name) {
                            flac.setTag(`GENRE=${genreObj.name}`);
                        }
                    });
                } catch (error) {
                    console.error('Error setting genre tags:', error);
                }
            };
            if (this.settings.trackTotal) flac.setTag(`TRACKTOTAL=${this.publicAlbum.nb_tracks}`);
            if (this.settings.explicit) flac.setTag(`ITUNESADVISORY=${this.track.explicit ? "1" : "0"}`);
            if (this.settings.source) {
                flac.setTag('SOURCE=Deezer')
                flac.setTag(`SOURCEID=${this.publicTrack.id}`)
            };

            if (this.settings.cover) {
                if (cover) flac.importPicture(cover);
            }
            flac.save();
        }
    }

    async downloadCover(url) {
        return await new Promise((res) => {
            let out = Buffer.alloc(0);
            https.get(url, (r) => {
                r.on('data', (d) => {
                    out = Buffer.concat([out, d]);
                });
                r.on('end', () => {
                    res(out);
                });
            });
        });
    }

    generateLRC() {
        //Check if exists
        if (!this.rawTrack.results.LYRICS || !this.rawTrack.results.LYRICS.LYRICS_SYNC_JSON) return;
        let lyrics = new Lyrics(this.rawTrack.results.LYRICS);
        if (lyrics.lyrics.length == 0) return;
        //Metadata
        let out = `[ar:${this.track.artistString}]\r\n[al:${this.track.album.title}]\r\n[ti:${this.track.title}]\r\n`;
        //Lyrics
        for (let l of lyrics.lyrics) {
            if (l.lrcTimestamp && l.text)
                out += `${l.lrcTimestamp}${l.text}\r\n`;
        }
        return out;
    }

    // Helper method to format milliseconds into LRC timestamp
    formatTimestamp(ms) {
        let minutes = Math.floor(ms / 60000);
        let seconds = ((ms % 60000) / 1000).toFixed(2);
        return `[${minutes}:${seconds < 10 ? '0' : ''}${seconds}]`;
    }


    generatePath(quality) {
        //Path
        let folder = this.settings.downloadsPath;
        if (this.download.path)
            folder = this.download.path;

        //User uploaded mp3s
        if (this.isUserUploaded) {
            //Generate path
            if (this.settings.createArtistFolder && this.download.track.artists[0].name.length > 0)
                folder = path.join(folder, sanitize(this.download.track.artists[0].name));
            if (this.settings.createAlbumFolder && this.download.track.album.title.length > 0) {
                folder = path.join(folder, sanitize(this.download.track.album.title));
                if (this.settings.albumsbydisk && this.download.track.diskNumber > 0) {
                    folder = path.join(folder, sanitize(this.download.track.diskNumber));
                }
            }
            //Filename
            let out = path.join(folder, sanitize(this.download.track.title));
            if (!out.includes('.'))
                out += '.mp3';
            return out;
        }

        //Generate filename
        let fn = this.settings.downloadFilename;

        //Disable feats for single artist
        let feats = '';
        if (this.track.artists.length >= 2)
            feats = this.track.artists.slice(1).map((a) => a.name).join(', ');

        //Date
        let date = new Date(this.publicTrack.release_date);

        let props = {
            '%title%': this.track.title,
            '%artists%': this.track.artistString,
            '%artist%': this.track.artists[0].name,
            '%feats%': feats,
            '%trackNumber%': (this.track.trackNumber ? this.track.trackNumber : 1).toString(),
            '%0trackNumber%': (this.track.trackNumber ? this.track.trackNumber : 1).toString().padStart(2, '0'),
            '%album%': this.track.album.title,
            '%albumArtist%': this.track.album.artists[0].name,
            '%albumArtists%': this.track.album.artistString,
            '%year%': date.getFullYear().toString(),
            '%label%': (this.publicAlbum.label) ? this.publicAlbum.label : ''
        };
        for (let k of Object.keys(props)) {
            fn = fn.replace(new RegExp(k, 'g'), sanitize(props[k]));
        }
        //Generate folders
        if (this.settings.createArtistFolder) folder = path.join(folder, sanitize(this.track.artists[0].name));
        if (this.settings.createAlbumFolder) {
            folder = path.join(folder, sanitize(this.track.album.title));
            if (this.settings.downloadAlbumCover) {
                this.coverPath = path.join(folder, "cover.jpg");
            }
            if (this.settings.albumsbydisk && this.download.track.diskNumber > 0) {
                folder = path.join(folder, sanitize(this.download.track.diskNumber));
            }
        }

        //Cut path to fit into windows limits
        if (fn.length >= 249) {
            fn = fn.substring(0, 249);
        }

        //Extension
        if (quality.toString() == '9') {
            fn += '.flac';
        } else {
            fn += '.mp3';
        }

        return path.join(folder, fn);
    }
}

class Download {
    constructor(track, quality, state, path) {
        this.track = track;
        this.quality = quality;
        this.path = path;

        // 0 - none
        // 1 - downloading
        // 2 - postprocess
        // 3 - done
        // -1 - error
        this.state = state;

        //Updated from threads
        this.downloaded = 0;
        this.size = 1;
    }

    toDB() {
        return {
            _id: this.track.id,
            track: this.track,
            quality: this.quality,
            state: this.state,
            path: this.path
        }
    }

    static fromDB(json) {
        return new Download(json.track, json.quality, json.state, json.path);
    }
}

module.exports = { DownloadManager }