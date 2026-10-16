import pickerScript from '../content/picker.ts?script';

export async function injectPicker(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: [pickerScript],
  });
}
