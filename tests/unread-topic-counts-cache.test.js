'use strict';
// get-unread-topic-counts on real files. Expected counts are worked out by hand from the histories.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const fsExtra = require('fs-extra');

const HANDLERS = require.resolve('../modules/ipc/chatHandlers');
const user = { role: 'user', content: 'u' };
const assistant = { role: 'assistant', content: 'a' };

function fixture(t, topics) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vcp-unread-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (file, value) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value));
    };
    const history = id => path.join(root, 'UserData', 'agent', 'topics', id, 'history.json');
    const writeTopics = list => write(path.join(root, 'Agents', 'agent', 'config.json'),
        { topics: list.map(({ id, unread, unreadSource }) => ({ id, unread, unreadSource })) });
    writeTopics(topics);
    for (const topic of topics) write(history(topic.id), topic.messages);
    return { root, write, history, writeTopics };
}

function loadHandler(root) {
    const handlers = new Map();
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') {
            return { ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {}, removeHandler() {} },
                BrowserWindow: { getAllWindows: () => [] }, dialog: {},
                app: { getPath: () => root, getAppMetrics: () => [], isPackaged: false } };
        }
        return load.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[HANDLERS];
        require(HANDLERS).initialize(null, { AGENT_DIR: path.join(root, 'Agents'), USER_DATA_DIR: path.join(root, 'UserData'),
            APP_DATA_ROOT_IN_PROJECT: root });
    } finally { Module._load = load; }
    return () => handlers.get('get-unread-topic-counts')();
}

function countHistoryReads(t, onRead = () => {}) {
    const original = fsExtra.readJson;
    const reads = [];
    fsExtra.readJson = async function (file, ...args) {
        if (path.basename(file) === 'history.json') { reads.push(path.basename(path.dirname(file))); await onRead(reads.length); }
        return original.call(this, file, ...args);
    };
    t.after(() => { fsExtra.readJson = original; });
    return reads;
}

const TOPICS = [
    { id: 'joined', messages: [user, assistant] },
    { id: 'agent-only', messages: [assistant, assistant, { role: 'system', content: 's' }] },
    { id: 'manual', unread: true, unreadSource: 'manual', messages: [user] },
];

test('a later call reads no history that has not changed, and gives the same counts', async (t) => {
    const { root } = fixture(t, TOPICS);
    const call = loadHandler(root);
    const first = await call();
    assert.deepEqual(first, { success: true, counts: { agent: 2 } });
    const reads = countHistoryReads(t);
    assert.deepEqual(await call(), first);
    assert.deepEqual(reads, []);
});

test('a changed history is read again and the count follows it', async (t) => {
    const { root, write, history } = fixture(t, TOPICS);
    const call = loadHandler(root);
    await call();
    write(history('agent-only'), [assistant, assistant, assistant, assistant]);
    const reads = countHistoryReads(t);
    assert.deepEqual(await call(), { success: true, counts: { agent: 4 } });
    assert.deepEqual(reads, ['agent-only']);
});

test('topic flags are not cached: marking a topic unread shows without a history write', async (t) => {
    const { root, writeTopics } = fixture(t, [{ id: 'joined', messages: [user, assistant] }]);
    const call = loadHandler(root);
    assert.deepEqual(await call(), { success: true, counts: {} });
    writeTopics([{ id: 'joined', unread: true, unreadSource: 'manual' }]);
    assert.deepEqual(await call(), { success: true, counts: { agent: 0 } });
});

test('two calls at once read each history once', async (t) => {
    const { root } = fixture(t, TOPICS);
    const reads = countHistoryReads(t);
    const call = loadHandler(root);
    const [first, second] = await Promise.all([call(), call()]);
    assert.deepEqual(first, { success: true, counts: { agent: 2 } });
    assert.deepEqual(second, first);
    assert.equal(reads.length, TOPICS.length);
});

test('a call made during a pass sees a change the pass had already gone past', async (t) => {
    const { root, write, history } = fixture(t, [{ id: 'a', messages: [assistant] }, { id: 'b', messages: [assistant] }]);
    const call = loadHandler(root);
    let late;
    countHistoryReads(t, (count) => {
        if (count !== 2) return;
        write(history('a'), [assistant, assistant, assistant]);
        late = call();
    });
    assert.deepEqual(await call(), { success: true, counts: { agent: 2 } });
    assert.deepEqual(await late, { success: true, counts: { agent: 4 } });
});
