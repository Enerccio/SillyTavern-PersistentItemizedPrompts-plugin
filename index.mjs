import path from 'node:path';
import sqlite from 'node:sqlite';

import zlib from 'zlib';
import chalk from 'chalk';
import { getConfigValue } from '../../src/util.js';

const MODULE = '[SillyTavern-PersistentItemizedPrompts-plugin]';

class ItemizedPromptsDB {

    compressing = getConfigValue("persistentprompts.compression", true, 'boolean');

    constructor(db) {
        this.db = db;
    }

    async initialize() {
        const data = await this._fetchFirst("SELECT name FROM sqlite_master WHERE type='table' AND name='prompts'");
        this.exist = !! (data && data['name']);
        if (!this.exist) {
            await this._execute("CREATE TABLE prompts (chat_id TEXT, message_id TEXT, prompt BLOB, PRIMARY KEY (chat_id, message_id))");
        }
    }

    async vaacum() {
        await this._execute("VAACUM prompts");
    }

    async close() {
        await this.db.close()
    }

    async persist(chatId, messageId, request) {
        const stringValue = JSON.stringify(request);
        let blob;
        if (this.compressing) {
            blob = zlib.deflateSync(Buffer.from(stringValue, 'utf8'));
        } else {
            blob = Buffer.from(stringValue, 'utf8');
        }
        await this._execute("INSERT INTO prompts(chat_id, message_id, prompt) VALUES(?, ?, ?) ON CONFLICT(chat_id, message_id) DO UPDATE SET prompt=?",
            [chatId, messageId, blob, blob]);
    }

    async deleteMessage(chatId, messageId) {
        await this._execute("DELETE FROM prompts WHERE chat_id = ? AND message_id = ?", [chatId, messageId]);
    }

    async getAllIds(chatId) {
        const rows = await this._fetchAll("SELECT message_id FROM prompts WHERE chat_id = ? ORDER BY message_id", [chatId]);
        return rows.map((row) => row.message_id);
    }

    async getPrompts(chatId, ids) {
        // strange query but recommended by sqlite
        // https://stackoverflow.com/questions/34349199/node-js-sqlite3-in-operator
        const rows = await this._fetchAll("SELECT message_id, prompt FROM prompts WHERE chat_id = ? AND message_id in (SELECT value FROM json_each(?))", [chatId,
            JSON.stringify(ids)]);
        return rows.map((row) => {
            let promptBuffer = row.prompt;
            if (this.compressing) {
                promptBuffer = zlib.inflateSync(promptBuffer);
            }
            return {
                "prompt": JSON.parse(promptBuffer.toString('utf8')),
                "id": row.message_id,
            };
        });
    }

    async delete(chatId) {
        await this._execute("DELETE FROM prompts WERE chat_id = ?", [chatId]);
    }

    async deleteAll() {
        await this._execute("DELETE FROM prompts");
    }

    async _execute(sql, params = []) {
        if (params && params.length > 0) {
           const ps = this.db.prepare(sql);
           ps.run({}, ...params);
        }

        this.db.exec(sql);
    }

    async _fetchAll (sql, params=[]) {
        const ps = this.db.prepare(sql);
        return ps.all({}, ...params);
    }

    async _fetchFirst (sql, params=[]) {
        const ps = this.db.prepare(sql);
        return ps.get({}, ...params);
    };

}

class PersistentItemizedPrompts {

    openedDatabases = {};

    constructor() {

    }

    async open(handle, directories) {
        if (!this.openedDatabases[handle]) {
            const db = new sqlite.DatabaseSync(this._getPathForHandle(handle, directories));
            this.openedDatabases[handle] = new ItemizedPromptsDB(db);
            await this.openedDatabases[handle].initialize();
            return this.openedDatabases[handle].exist;
        }
        return true;
    }

    async closeAll() {
        for (const db of Object.values(this.openedDatabases)) {
            db.vaacum();
            db.close();
        }
        this.openedDatabases = {};
    }

    async persist(handle, directories, chatId, messageId, request) {
        if (!this.openedDatabases[handle]) {
            await this.open(handle, directories);
        }
        this.openedDatabases[handle].persist(chatId, messageId, request);
    }

    async deleteMessage(handle, directories, chatId, messageId) {
        if (!this.openedDatabases[handle]) {
            await this.open(handle, directories);
        }
        this.openedDatabases[handle].deleteMessage(chatId, messageId);
    }

    async bulk(handle, directories, chatId, bulkOperations) {
        if (!this.openedDatabases[handle]) {
            await this.open(handle, directories);
        }
        const db = this.openedDatabases[handle];
        for (let bulkOperation of bulkOperations) {
            const messageId = bulkOperation.messageId;
            const operation = bulkOperation.op;
            if (operation === 'delete') {
                db.deleteMessage(chatId, messageId);
            } else if (operation === 'persist') {
                db.persist(chatId, messageId, bulkOperation.data);
            }
        }
    }

    async getAllIds(handle, directories, chatId) {
        if (!this.openedDatabases[handle]) {
            await this.open(handle, directories);
        }
        return await this.openedDatabases[handle].getAllIds(chatId);
    }

    async getPrompts(handle, directories, chatId, ids) {
        if (!this.openedDatabases[handle]) {
            await this.open(handle, directories);
        }
        return await this.openedDatabases[handle].getPrompts(chatId, ids);
    }

    async delete(handle, directories, chatId) {
        if (!this.openedDatabases[handle]) {
            await this.open(handle, directories);
        }

        return await this.openedDatabases[handle].delete(chatId);
    }

    async deleteALl(handle, directories) {
        if (!this.openedDatabases[handle]) {
            await this.open(handle, directories);
        }

        return await this.openedDatabases[handle].deleteAll();
    }

    _getPathForHandle(handle, directories) {
        return path.join(directories.root, "itemizedPrompts.sqlite");
    }

}

const persistentItemizedPrompts = new PersistentItemizedPrompts();

export async function init(router) {
    if (router) {
        console.log(chalk.green(MODULE), "Initializing itemized prompts to persistent storage");

        router.post("/open", async (req, res) => {
            const handle = req.user.profile.handle;
            const directories  = req.user.directories;
            if (handle) {
                const tableExists = await persistentItemizedPrompts.open(handle, directories);
                res.status(tableExists ? 200 : 201).send('OK');
            }
        });

        router.post("/persist", async (req, res) => {
            const handle = req.user.profile.handle;
            const directories  = req.user.directories;
            const chatId = req.query.chatId;
            const mesId = req.query.mesId;
            if (handle) {
                await persistentItemizedPrompts.persist(handle, directories, chatId, mesId, req.body);
                res.status(200).send('OK');
            }
        });

        router.post("/delete", async (req, res) => {
            const handle = req.user.profile.handle;
            const directories  = req.user.directories;
            const chatId = req.query.chatId;
            const mesId = req.query.mesId;
            if (handle) {
                await persistentItemizedPrompts.deleteMessage(handle, directories, chatId, mesId);
                res.status(200).send('OK');
            }
        });

        router.post("/bulk", async (req, res) => {
            const handle = req.user.profile.handle;
            const directories  = req.user.directories;
            const chatId = req.query.chatId;
            if (handle) {
                await persistentItemizedPrompts.bulk(handle, directories, chatId, req.body);
                res.status(200).send('OK');
            }
        });

        router.get("/mesIds", async (req, res) => {
            const handle = req.user.profile.handle;
            const directories  = req.user.directories;
            const chatId = req.query.chatId;
            if (handle) {
                const ids = await persistentItemizedPrompts.getAllIds(handle, directories, chatId);
                res.status(200).send(JSON.stringify(ids));
            }
        });

        router.post("/prompts", async (req, res) => {
            const handle = req.user.profile.handle;
            const directories  = req.user.directories;
            const chatId = req.query.chatId;
            if (handle) {
                const data = await persistentItemizedPrompts.getPrompts(handle, directories, chatId, req.body);
                res.status(200).send(JSON.stringify(data));
            }
        });

        router.get("/delete", async (req, res) => {
            const handle = req.user.profile.handle;
            const directories  = req.user.directories;
            const chatId = req.query.chatId;
            if (handle) {
                await persistentItemizedPrompts.delete(handle, directories, chatId);
                res.status(200).send('OK');
            }
        });

        router.get("/deleteAll", async (req, res) => {
            const handle = req.user.profile.handle;
            const directories  = req.user.directories;
            if (handle) {
                await persistentItemizedPrompts.deleteAll(handle, directories);
                res.status(200).send('OK');
            }
        });
    }
}

export async function exit() {
    await persistentItemizedPrompts.closeAll();
}


export const info = {
    id: 'persistentitemizedprompts',
    name: 'SillyTavern-PersistentItemizedPrompts',
    description: 'This is a server side part of the SillyTaver-PersistentItemizedPrompts.',
}
