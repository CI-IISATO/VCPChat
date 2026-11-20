import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import { createSideChatAttachments } from '../modules/renderer/side-chat/attachments.js';

const MiB = 1024 * 1024;
function nativePicker({ limit, sizes }) {
    const url = new URL('../modules/ipc/chatHandlers.js', import.meta.url);
    const require = createRequire(url);
    const handlers = new Map();
    const calls = [];
    const module = { exports: {} };
    const deps = {
        electron: {
            ipcMain: { handle: (name, callback) => handlers.set(name, callback), on() {}, removeHandler() {} },
            dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: Object.keys(sizes) }) },
            BrowserWindow: { fromWebContents() {} }
        },
        'fs-extra': { stat: async name => {
            calls.push(`stat:${name}`);
            return { isFile: () => true, size: sizes[name] };
        } },
        './workspaceHandlers': { resolveWorkspaceFile() { return null; } },
        '../fileManager': { storeFile: async name => {
            calls.push(`store:${name}`);
            return { name, size: sizes[name] };
        } }
    };
    const run = vm.runInThisContext(`(function(require, module, exports) {${readFileSync(url, 'utf8')}\n})`, {
        filename: fileURLToPath(url),
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
    });
    run(name => deps[name] ?? require(name), module, module.exports);
    module.exports.initialize({}, {
        historyMutationQueue: {},
        getSelectionListenerStatus: () => false,
        settingsManager: {
            readSettings: async () => ({ currentAttachmentBudgetMiB: limit }),
            updateSettings: async () => calls.push('remember')
        }
    });
    return { calls, pick: sizes => handlers.get('select-files-to-send')({ sender: {} }, 'a', 't', sizes) };
}

test('native picker rejects the whole selection before directory memory, storage or extraction', async () => {
    const { pick, calls } = nativePicker({ limit: 1, sizes: { 'small.txt': 1, 'long.pdf': MiB / 2 } });
    const result = await pick([{ size: MiB / 2 }]);
    assert.equal(result.success, false);
    assert.match(result.warning, /超过/);
    assert.deepEqual(result.attachments, []);
    assert.deepEqual(calls, ['stat:small.txt', 'stat:long.pdf']);
});

test('native picker accepts a batch exactly at the limit and skips metadata reads when disabled', async () => {
    const enabled = nativePicker({ limit: 1, sizes: { 'a.txt': MiB / 2, 'b.txt': MiB / 4 } });
    assert.equal((await enabled.pick([{ size: MiB / 4 }])).success, true);
    assert.deepEqual(enabled.calls, ['stat:a.txt', 'stat:b.txt', 'remember', 'store:a.txt', 'store:b.txt']);

    const disabled = nativePicker({ limit: 0, sizes: { 'a.txt': MiB * 2 } });
    assert.equal((await disabled.pick()).success, true);
    assert.deepEqual(disabled.calls, ['remember', 'store:a.txt']);
});

function fakeSideChat(api) {
    const buttons = () => ({
        events: {},
        addEventListener(type, fn) { this.events[type] = fn; },
        removeEventListener(type) { delete this.events[type]; }
    });
    const attachBtn = buttons();
    const textarea = buttons();
    const dropTarget = buttons();
    const warnings = [];
    const owner = createSideChatAttachments({
        chatCapabilities: {
            getAttachmentBudgetMiB: () => 1,
            electronAPI: api,
            uiHelper: { showToastNotification: (text, level) => warnings.push({ text, level }) }
        },
        descriptor: { child: { itemId: 'agent', topicId: 'side' } },
        attachBtn, textarea, dropTarget, previewArea: {}
    });
    return {
        owner, warnings,
        pick: () => attachBtn.events.click(),
        paste: files => textarea.events.paste({
            clipboardData: { items: files.map(file => ({ kind: 'file', getAsFile: () => file })) },
            preventDefault() {}
        }),
        drop: files => dropTarget.events.drop({ dataTransfer: { types: ['Files'], files }, preventDefault() {} })
    };
}

test('side chat rejects a whole pasted or dropped batch before reading any File', async () => {
    let reads = 0;
    let writes = 0;
    const chat = fakeSideChat({ handleFileDrop: async () => { writes++; } });
    chat.owner.restore([{ file: { size: MiB / 2 }, originalName: 'draft' }]);
    const batch = [MiB / 2, 1].map(size => ({
        size, arrayBuffer: async () => { reads++; return new ArrayBuffer(size); }
    }));
    chat.drop(batch);
    chat.paste(batch);
    await setImmediate();
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    assert.equal(chat.warnings.length, 2);
    assert.ok(chat.warnings.every(({ text, level }) => level === 'warning' && /超过/.test(text)));
    assert.deepEqual(chat.owner.take().map(file => file.originalName), ['draft']);
});

test('side chat checks clipboard bitmap byte length before saving', async () => {
    let writes = 0;
    const chat = fakeSideChat({
        readImageFromClipboard: async () => ({ data: Buffer.alloc(MiB / 2 + 1).toString('base64') }),
        handleFilePaste: async () => { writes++; }
    });
    chat.owner.restore([{ file: { size: MiB / 2 } }]);
    chat.paste([null]);
    await setImmediate();
    assert.equal(writes, 0);
    assert.match(chat.warnings[0]?.text, /超过/);
    assert.equal(chat.owner.count, 1);
});

test('side chat picker rechecks the latest draft and rejects the whole concurrent batch', async () => {
    let resolvePicker;
    const picked = new Promise(resolve => { resolvePicker = resolve; });
    const chat = fakeSideChat({
        selectFilesToSend: (id, topic, draft) => {
            assert.deepEqual([id, topic, draft], ['agent', 'side', [{ size: 1 }]]);
            return picked;
        },
        handleFileDrop: async (_id, _topic, files) => files.map(({ size, name }) => ({
            success: true, attachment: { name, size }
        }))
    });
    chat.owner.restore([{ file: { size: 1 }, originalName: 'draft' }]);
    const pending = chat.pick();
    chat.drop([{ name: 'concurrent', size: MiB / 2, arrayBuffer: async () => new ArrayBuffer(MiB / 2) }]);
    await setImmediate();
    resolvePicker({ success: true, attachments: [{ name: 'first', size: 1 }, { name: 'second', size: MiB / 2 }] });
    await pending;
    assert.match(chat.warnings[0]?.text, /超过/);
    assert.deepEqual(chat.owner.take().map(file => file.originalName), ['draft', 'concurrent']);
});