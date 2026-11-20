import test from 'node:test';
import assert from 'node:assert/strict';
import * as pipeline from '../modules/chat/chatContextPipeline.js';
const { assembleRequestMessages, assertCurrentTurnMediaBudget } = pipeline;
import { createSingleChatRequestOrchestrator } from '../modules/chat/singleChatRequestOrchestrator.js';

const context = { agentId: 'a', topicId: 't' };
const file = (name, extra = {}) => ({ name, type: 'image/png', src: `file:///C:/attachments/${name}`, ...extra });
const image = (url) => ({ type: 'image_url', image_url: { url } });
const images = message => message.content.filter(part => part.type === 'image_url').map(part => part.image_url.url);

function fixture() {
    const reads = [];
    const electronAPI = {
        getFileAsBase64: async source => {
            reads.push(source);
            return { success: true, base64Frames: ['dGVzdA=='] };
        },
    };
    const older = {
        id: 'old', role: 'user', content: [
            { type: 'text', text: 'original prose' },
            image('data:image/png;base64,YQ=='),
        ],
        attachments: [
            file('old.png'),
            file('relative.png', { src: 'file://relative.png' }),
            file('embedded.png', { imageFrames: ['ZW1iZWRkZWQ='] }),
            { name: 'scan.pdf', type: 'application/pdf', src: 'file:///C:/attachments/scan.pdf', imageFrames: ['cGRm'] },
            file('voice.wav', { type: 'audio/wav' }),
        ],
    };
    const current = {
        id: 'now', role: 'user', content: 'next',
        attachments: Array.from({ length: 16 }, (_, index) => file(`new-${index}.png`)),
    };
    return { electronAPI, reads, history: [older, current], older, current };
}

test('opt-in protection leaves old prose and opaque media intact, and keeps all sixteen new images', async () => {
    const { electronAPI, reads, history, current } = fixture();
    const before = structuredClone(history);
    const result = await assembleRequestMessages({
        electronAPI, history, context, currentUserMessage: current,
        settings: { omitHistoricalFileImages: true },
    });
    const [past, now] = result.messagesForVCP;
    assert.equal(images(past).length, 5);
    assert.match(past.content[0].text, /original prose/);
    assert.match(past.content[0].text, /file:\/\/\/C:\/attachments\/old\.png/);
    assert.equal(reads.includes('file:///C:/attachments/old.png'), false);
    assert.equal(images(now).length, 16);
    assert.deepEqual(history, before);
});

test('default request still resends historical image bytes; explicit settings protect normal and regenerated turns alike', async () => {
    const { electronAPI, history, current } = fixture();
    const orchestrator = createSingleChatRequestOrchestrator({ electronAPI });
    const options = { history, context, agentConfig: {}, messageId: 'reply', currentUserMessageId: current.id };
    const legacy = await orchestrator.buildRequest({ ...options, settings: {} });
    assert.equal(images(legacy.messages[0]).length, 6);
    const settings = { omitHistoricalFileImages: true };
    const normal = await orchestrator.buildRequest({ ...options, settings });
    const regenerated = await assembleRequestMessages({ electronAPI, history, context, currentUserMessage: current, settings });
    assert.deepEqual(normal.messages, regenerated.messagesForVCP);
    assert.equal(images(normal.messages[0]).length, 5);
});

test('configured media budget counts inline encoded bytes and rejects the whole turn over budget', async () => {
    const { electronAPI, current, reads } = fixture();
    await assertCurrentTurnMediaBudget({ electronAPI, message: current, settings: {} });
    assert.equal(reads.length, 0);
    const limits = { singleChatMediaBudgetMiB: 1 };
    await assertCurrentTurnMediaBudget({ electronAPI, message: current, settings: limits });
    const url = prefix => `data:image/png;base64,${'A'.repeat(prefix)}`;
    const exact = url(1024 * 1024 - 'data:image/png;base64,'.length);
    const message = { role: 'user', content: [image(exact)] };
    await assertCurrentTurnMediaBudget({ electronAPI, message, settings: limits });
    message.content.push(image(url(4)));
    await assert.rejects(
        assertCurrentTurnMediaBudget({ electronAPI, message, settings: limits }),
        /本轮媒体.*预算/,
    );
});