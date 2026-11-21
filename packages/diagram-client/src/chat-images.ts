/**
 * Images the chat's composer takes: pasted (a screenshot, an image copied from
 * a page) or dropped on it, read into the base64 an ACP `image` block carries.
 * What can be sent is decided with the host (`@dialogram/shared` chat-images).
 */
import type { ChatImage } from '@dialogram/shared';

/** The items of a paste or a drop that are image files. */
function imageItems(transfer: DataTransfer): DataTransferItem[] {
    return Array.from(transfer.items ?? []).filter(item => item.kind === 'file' && item.type.startsWith('image/'));
}

/** Whether a drag carries an image file: until the drop, its items say their kind, not their bytes. */
export function carriesImages(transfer: DataTransfer | null | undefined): boolean {
    return !!transfer && imageItems(transfer).length > 0;
}

/** The image files a paste or a drop carries. */
export function imageFiles(transfer: DataTransfer | null | undefined): File[] {
    if (!transfer) {
        return [];
    }
    const fromItems = imageItems(transfer).map(item => item.getAsFile()).filter((file): file is File => !!file);
    if (fromItems.length > 0) {
        return fromItems;
    }
    return Array.from(transfer.files ?? []).filter(file => file.type.startsWith('image/'));
}

/** An image file, read: its kind and its bytes, base64. */
export function readImageFile(file: File): Promise<ChatImage> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`${file.name || 'the image'} could not be read`));
        reader.onload = () => {
            const url = typeof reader.result === 'string' ? reader.result : '';
            const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);
            if (!match) {
                reject(new Error(`${file.name || 'the image'} could not be read`));
                return;
            }
            resolve({ mimeType: file.type || match[1], data: match[2] });
        };
        reader.readAsDataURL(file);
    });
}

/** The `data:` URL an image is shown from (the webview's policy allows `data:` images). */
export function imageSrc(image: ChatImage): string {
    return `data:${image.mimeType};base64,${image.data}`;
}
