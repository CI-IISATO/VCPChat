const MIB = 1024 * 1024;

function formatMiB(bytes) {
    return (bytes / MIB).toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

function fileBytes(attachment) {
    return attachment?._fileManagerData?.size ?? attachment?.file?.size ?? attachment?.size;
}

function sumBytes(files) {
    let total = 0;
    for (const file of files) {
        const size = fileBytes(file);
        if (!Number.isSafeInteger(size) || size < 0) return NaN;
        total += size;
    }
    return total;
}

export function attachmentIntakeWarning(existing, incoming, limitMiB) {
    if (!Number.isSafeInteger(limitMiB) || limitMiB <= 0 || !incoming?.length) return '';
    const used = sumBytes(existing || []);
    const added = sumBytes(incoming);
    const total = used + added;
    if (!Number.isFinite(total)) return '无法确认附件大小，本次未添加。已有草稿不变。';
    if (total <= limitMiB * MIB) return '';
    const actual = formatMiB(total) === formatMiB(limitMiB * MIB)
        ? `${total.toLocaleString('zh-CN')} 字节` : `${formatMiB(total)} MiB`;
    return `已有 ${formatMiB(used)} MiB，本次 ${formatMiB(added)} MiB，合计 ${actual}，超过 ${limitMiB} MiB 上限。本次未添加，已有草稿不变。`;
}

/** A composer limit measured in original-file bytes, not model tokens or request bytes. */
export function currentAttachmentBudgetWarning(attachments, limitMiB) {
    if (!Number.isSafeInteger(limitMiB) || limitMiB <= 0 || !attachments?.length) return '';

    const total = sumBytes(attachments);
    if (!Number.isFinite(total)) return '无法确认本轮附件合计大小，草稿已保留。请重新选择附件后再发送。';

    if (total <= limitMiB * MIB) return '';
    const displayed = formatMiB(total);
    const limit = formatMiB(limitMiB * MIB);
    const actual = displayed === limit ? `${total.toLocaleString('zh-CN')} 字节` : `${displayed} MiB`;
    return `本轮附件合计 ${actual}，超过 ${limit} MiB 的发送上限。草稿已保留，请移除部分附件或分批发送。`;
}