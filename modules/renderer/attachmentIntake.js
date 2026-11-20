export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

export function attachmentLimitNotice(rejectedCount) {
    return `单条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 个附件，本次有 ${rejectedCount} 个未添加。`;
}

export function createAttachmentIntake(getCount) {
    let pending = Promise.resolve();
    return function queueIntake(add) {
        const result = pending.then(() => add(Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - getCount())));
        pending = result.catch(() => {});
        return result;
    };
}