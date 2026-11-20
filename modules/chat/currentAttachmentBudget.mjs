const MIB = 1024 * 1024;

function formatMiB(bytes) {
    return (bytes / MIB).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

/** A composer limit measured in original-file bytes, not model tokens or request bytes. */
export function currentAttachmentBudgetWarning(attachments, limitMiB) {
    if (!Number.isSafeInteger(limitMiB) || limitMiB <= 0 || !attachments?.length) return '';

    let total = 0;
    for (const attachment of attachments) {
        const size = attachment?._fileManagerData?.size ?? attachment?.file?.size ?? attachment?.size;
        if (!Number.isSafeInteger(size) || size < 0) {
            return '无法确认本轮附件合计大小，草稿已保留。请重新选择附件后再发送。';
        }
        total += size;
    }

    if (total <= limitMiB * MIB) return '';
    const displayed = formatMiB(total);
    const limit = formatMiB(limitMiB * MIB);
    const actual = displayed === limit ? `${total.toLocaleString('zh-CN')} 字节` : `${displayed} MiB`;
    return `本轮附件合计 ${actual}，超过 ${limit} MiB 的发送上限。草稿已保留，请移除部分附件或分批发送。`;
}