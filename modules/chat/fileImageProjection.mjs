export function projectHistoricalFileImages(message) {
    if (!Array.isArray(message?.attachments)) return { message, references: [] };
    const references = [];
    const attachments = message.attachments.filter(attachment => {
        const data = attachment?._fileManagerData || attachment || {};
        const type = data.type || attachment?.type || '';
        if (!type.startsWith('image/') || data.isLiveReference || attachment?.isLiveReference
            || data.workspaceRef || attachment?.workspaceRef || data.extractedText || attachment?.extractedText
            || data.imageFrames?.length || attachment?.imageFrames?.length) return true;
        const source = attachment?.src || attachment?.internalPath || data.internalPath || attachment?.localPath;
        if (typeof source !== 'string' || !/^file:\/\/(?:\/?[a-z]:[/\\][^\r\n]+|\/[^/\r\n][^\r\n]*|\\\\[^\\\r\n]+\\[^\r\n]+|[^/\\\r\n]+\/[^/\r\n]+\/[^\r\n]+)$/i.test(source)) return true;
        references.push(`\n\n[历史图片：本次未附图像数据，仅保留文件引用：${source}]`);
        return false;
    });
    return { message: references.length ? { ...message, attachments } : message, references };
}

// Group requests carry the original stored file, or the already encoded pages of a scanned document.
export function checkGroupMediaBudget(attachments, mib) {
    if (!Number.isSafeInteger(mib) || mib <= 0) return;
    let total = 0;
    for (const att of attachments || []) {
        const data = att?._fileManagerData || {};
        const frames = data.imageFrames || att.imageFrames;
        const type = data.type || att.type || '';
        if (frames?.length) {
            for (const frame of frames) total += 'data:image/jpeg;base64,'.length + frame.length;
        } else if (/^(?:image|audio|video)\//.test(type)) {
            const size = data.size ?? att.size;
            if (!Number.isSafeInteger(size) || size < 0) throw new Error('无法确认本轮媒体大小，请重新选择附件。');
            total += `data:${type};base64,`.length + 4 * Math.ceil(size / 3);
        }
        if (total > mib * 1024 * 1024) throw new Error(`本轮媒体超过 ${mib} MiB 的本地发送预算，请选图或分批发送。`);
    }
}