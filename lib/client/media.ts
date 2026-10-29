/** Downscales photos before encryption so they upload fast and stay under the size cap. */
export async function prepareImage(file: File, maxSide = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not process the image"))), "image/jpeg", 0.85),
  );
  // A tiny blurred preview travels inside the encrypted message for instant rendering.
  const tiny = document.createElement("canvas");
  const ts = 24 / Math.max(width, height);
  tiny.width = Math.max(1, Math.round(width * ts));
  tiny.height = Math.max(1, Math.round(height * ts));
  tiny.getContext("2d")!.drawImage(bitmap, 0, 0, tiny.width, tiny.height);
  bitmap.close();
  return { blob, width, height, thumb: tiny.toDataURL("image/jpeg", 0.6) };
}

export function pickRecorderMime() {
  const options = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return options.find((m) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) ?? "";
}
