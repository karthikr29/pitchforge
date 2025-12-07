import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import { encode as btoa } from "base-64";
import { AudioItem } from "../types";

export type QueueState = {
  queue: AudioItem[];
  playing: boolean;
};

export class AudioQueue {
  private queue: AudioItem[] = [];
  private sound: Audio.Sound | null = null;

  enqueue(item: AudioItem) {
    this.queue.push(item);
  }

  clear() {
    this.queue = [];
    this.stop();
  }

  next(): AudioItem | undefined {
    return this.queue.shift();
  }

  items() {
    return [...this.queue];
  }

  isEmpty() {
    return this.queue.length === 0;
  }

  async stop() {
    if (this.sound) {
      await this.sound.unloadAsync();
      this.sound = null;
    }
  }

  async playNext(onFinish?: () => void) {
    if (this.sound) {
      await this.sound.unloadAsync();
      this.sound = null;
    }

    const next = this.next();
    if (!next) return;

    const { sound } = await Audio.Sound.createAsync({ uri: next.uri });
    this.sound = sound;
    sound.setOnPlaybackStatusUpdate((status) => {
      if (!status.isLoaded) return;
      if (status.didJustFinish) {
        onFinish?.();
      }
    });
    await sound.playAsync();
  }
}

export async function cacheTtsToFile(id: string, arrayBuffer: ArrayBuffer) {
  const path = `${FileSystem.cacheDirectory}tts-${id}.mp3`;
  const base64 = arrayBufferToBase64(arrayBuffer);
  await FileSystem.writeAsStringAsync(path, base64, {
    encoding: FileSystem.EncodingType.Base64
  });
  return path;
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

