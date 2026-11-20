'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../Groupmodules/grouprenderer.js'), 'utf8');
const body = source.slice(source.indexOf('async function handleSendGroupMessage()'),
    source.indexOf('async function loadGroupChatHistory('));

function fixture({ settings = {}, sizes } = {}) {
    let selected = { type: 'group', id: 'g1' };
    let topic = 't1';
    let files = [{ file: { type: 'text/plain', size: 12 }, originalName: 'a.txt',
        localPath: 'file:///a.txt', _fileManagerData: { internalPath: 'C:\\a.txt', extractedText: 'FILE TEXT' } }];
    if (sizes) files = sizes.map((size, i) => ({
        file: { type: 'image/png', size }, originalName: `${i}.png`, localPath: `file:///${i}.png`,
    }));
    const input = { value: ' hello ' };
    let accept;
    let submitted;
    let clears = 0;
    const notices = [];
    const script = new vm.Script(`(${body.trim()})`, {
        filename: path.join(__dirname, '../Groupmodules/grouprenderer.js'),
        importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    });
    const send = script.runInNewContext({
        console, Date, Math,
        mainRendererElements: { messageInput: input },
        currentSelectedItemRef: { get: () => selected },
        currentTopicIdRef: { get: () => topic },
        globalSettings: { get: () => ({ vcpServerUrl: 'http://fixture.invalid', userName: 'Ryan', ...settings }) },
        mainRendererFunctions: {
            getAttachedFiles: () => files,
            clearAttachedFiles: () => { clears++; files = []; },
            updateAttachmentPreview: () => {},
        },
        uiHelper: { autoResizeTextarea: () => {}, showToastNotification: (...args) => notices.push(args) },
        electronAPI: { topicAdmissionSubmit: value => {
            submitted = structuredClone(value);
            return new Promise(resolve => { accept = resolve; });
        } },
    });
    return {
        send, input, notices,
        get submitted() { return submitted; },
        get clears() { return clears; },
        accept: result => accept(result),
        switchTopic: () => { topic = 't2'; },
        changeFiles: () => { files = [...files]; },
    };
}

test('actual group send freezes human raw history and expanded attachment request; clears only after acceptance', async () => {
    const f = fixture();
    const pending = f.send();
    assert.equal(f.input.value, ' hello ');
    assert.equal(f.clears, 0);
    assert.equal(f.submitted.scope.topicId, 't1');
    assert.equal(f.submitted.message.role, 'user');
    assert.equal(f.submitted.message.content, 'hello');
    assert.match(f.submitted.message._metadata.groupRequestText, /FILE TEXT/);
    assert.equal(f.submitted.message.attachments[0].name, 'a.txt');
    f.accept({ success: true, queued: true });
    assert.equal((await pending).success, true);
    assert.equal(f.input.value, '');
    assert.equal(f.clears, 1);
});

test('group attachment total over limit keeps the whole draft and skips admission', async () => {
    const f = fixture({ settings: { currentAttachmentBudgetMiB: 1 }, sizes: [768 * 1024, 768 * 1024] });
    assert.equal((await f.send()).success, false);
    assert.equal(f.submitted, undefined);
    assert.equal(f.clears, 0);
    assert.equal(f.input.value, ' hello ');
    assert.match(f.notices[0][0], /1\.5 MiB.*超过 1 MiB/);
});

test('equal to the total attachment limit is admitted without rewriting attachments', async () => {
    const f = fixture({ settings: { currentAttachmentBudgetMiB: 1 }, sizes: [512 * 1024, 512 * 1024] });
    const pending = f.send();
    for (let i = 0; i < 100 && !f.submitted; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(f.submitted, 'the message was passed to admission');
    assert.equal(f.submitted.message.attachments.length, 2);
    f.accept({ success: true });
    assert.equal((await pending).success, true);
});

test('rejected admission retains group text and attachments', async () => {
    const f = fixture();
    const pending = f.send();
    f.accept({ success: false, error: 'disk failed' });
    assert.equal((await pending).success, false);
    assert.equal(f.input.value, ' hello ');
    assert.equal(f.clears, 0);
    assert.match(f.notices[0][0], /disk failed/);
});

test('late acceptance cannot clear a switched conversation, edited text or replaced attachment snapshot', async () => {
    for (const mutate of [f => f.switchTopic(), f => { f.input.value = 'new text'; }, f => f.changeFiles()]) {
        const f = fixture();
        const pending = f.send();
        mutate(f);
        f.accept({ success: true });
        await pending;
        assert.equal(f.clears, 0);
        assert.notEqual(f.input.value, '');
    }
});