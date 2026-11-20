import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';
import { createDomListenerOwner } from '../modules/renderer/domListenerOwner.js';
import { attachmentIntakeWarning } from '../modules/chat/currentAttachmentBudget.mjs';

const source = fs.readFileSync(new URL('../modules/inputEnhancer.js', import.meta.url), 'utf8');
const deferred = () => Promise.withResolvers();

function fixture(t, { listenerOwner, checkAttachmentBatch, handleFileDrop = async () => [] } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="composer"><textarea></textarea></div></body>', {
        runScripts: 'outside-only', url: 'http://localhost/',
    });
    const { window } = dom;
    window.console = { ...console, log() {} };
    window.alert = message => assert.fail(`Unexpected alert: ${message}`);
    window.electronPath = { basename: async value => value.split('\\').pop() };
    window.eval(source);
    const composer = window.document.getElementById('composer');
    const subscriptions = [];
    const attachments = [];
    let previews = 0;
    const refs = {
        messageInput: composer.querySelector('textarea'), dropTargetElement: composer,
        electronAPI: {
            onAddFileToInput: callback => {
                const subscription = { callback, disposals: 0, active: true };
                subscriptions.push(subscription);
                return () => { subscription.disposals += 1; subscription.active = false; };
            },
            handleFileDrop, searchNotes: async () => [],
        },
        attachedFiles: { append: attachment => attachments.push(attachment) },
        updateAttachmentPreview: () => { previews += 1; },
        checkAttachmentBatch: incoming => checkAttachmentBatch?.(attachments, incoming),
        getCurrentAgentId: () => 'agent', getCurrentTopicId: () => 'topic', listenerOwner,
    };
    t.after(async () => {
        await window.inputEnhancer.dispose();
        listenerOwner?.dispose();
        window.close();
    });
    const initialize = () => window.inputEnhancer.initializeInputEnhancer(refs);
    initialize();
    return { window, composer, subscriptions, attachments, initialize, get previews() { return previews; } };
}

for (const kind of ['drop', 'paste']) {
    test(`${kind}: over-limit batch leaves the original draft alone without reading files`, async t => {
        const warnings = [];
        let read = 0, stored = 0;
        const f = fixture(t, {
            handleFileDrop: async () => { stored++; return []; },
            checkAttachmentBatch: (existing, incoming) => {
                const text = attachmentIntakeWarning(existing, incoming, 1);
                if (text) warnings.push(text);
                return !text;
            },
        });
        f.window.FileReader = class { constructor() { read++; } };
        f.attachments.push({ file: { size: 512 * 1024 } });
        const input = f.composer.querySelector('textarea');
        input.value = '原草稿';
        const files = [1, 2].map(n => ({ name: `${n}.txt`, size: 384 * 1024, type: 'text/plain' }));
        const event = new f.window.Event(kind, { bubbles: true, cancelable: true });
        Object.defineProperty(event, kind === 'drop' ? 'dataTransfer' : 'clipboardData', { value: {
            files, items: files.map(file => ({ kind: 'file', getAsFile: () => file })),
        } });
        input.dispatchEvent(event);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /已有 0\.5 MiB.*本次 0\.75 MiB.*超过 1 MiB/);
        assert.equal(read, 0);
        assert.equal(stored, 0);
        assert.equal(f.attachments.length, 1);
        assert.equal(input.value, '原草稿');
    });
}

test('renderer owner removes real DOM listeners and preload subscriptions', async t => {
    const owner = createDomListenerOwner();
    const f = fixture(t, { listenerOwner: owner });
    f.composer.dispatchEvent(new f.window.Event('dragenter', { bubbles: true, cancelable: true }));
    assert.equal(f.composer.classList.contains('drag-over'), true);
    f.composer.classList.remove('drag-over');
    owner.dispose();
    f.composer.dispatchEvent(new f.window.Event('dragenter', { bubbles: true, cancelable: true }));
    assert.equal(f.composer.classList.contains('drag-over'), false);
    assert.equal(f.subscriptions[0].disposals, 1);
});

test('every dispose caller waits for pending preload work and late projection is suppressed', async t => {
    const result = deferred(), entered = deferred();
    const f = fixture(t, { handleFileDrop: () => { entered.resolve(); return result.promise; } });
    const pending = f.subscriptions[0].callback('C:\\tmp\\late.txt');
    await entered.promise;
    let firstDone = false, secondDone = false;
    const first = f.window.inputEnhancer.dispose().then(() => { firstDone = true; });
    const second = f.window.inputEnhancer.dispose().then(() => { secondDone = true; });
    try {
        await Promise.resolve();
        assert.equal(firstDone, false);
        assert.equal(secondDone, false, 'a repeated dispose must share the pending teardown barrier');
    } finally {
        result.resolve([{ success: true, attachment: { name: 'late.txt', internalPath: '/tmp/late.txt' } }]);
        await Promise.all([pending, first, second]);
    }
    assert.equal(f.attachments.length, 0);
    assert.equal(f.previews, 0);
    assert.equal(f.subscriptions[0].disposals, 1, 'standalone disposal must release the preload subscription');
});

test('reinitialization retires the old preload subscription and delivers only to the new instance', async t => {
    const owner = createDomListenerOwner();
    const f = fixture(t, {
        listenerOwner: owner,
        handleFileDrop: async () => [{ success: true, attachment: { name: 'current.txt', internalPath: '/tmp/current.txt' } }],
    });
    f.initialize();
    assert.equal(f.subscriptions[0].disposals, 1);
    assert.equal(f.subscriptions.filter(subscription => subscription.active).length, 1);
    await f.subscriptions[0].callback('C:\\tmp\\old.txt');
    await f.subscriptions[1].callback('C:\\tmp\\current.txt');
    assert.equal(f.attachments.length, 1);
    assert.equal(f.previews, 1);
    await f.window.inputEnhancer.dispose();
    owner.dispose();
    assert.deepEqual(f.subscriptions.map(subscription => subscription.disposals), [1, 1]);
});
