import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ScrollView, Animated } from "react-native";
import { Audio } from "expo-av";
// Use legacy FS API to avoid deprecated readAsStringAsync warnings.
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { v4 as uuidv4 } from "uuid";
import { personas } from "../src/constants/personas";
import { synthesizeTts } from "../src/api/client";
import { VoiceWsClient } from "../src/api/voiceWs";
import { splitBufferedText } from "../src/utils/sentenceSplitter";
import { AudioQueue, cacheTtsToFile } from "../src/utils/audioQueue";
import { useSessionStore } from "../src/state/useSessionStore";
import { Message } from "../src/types";
import { useTheme } from "../src/context/ThemeContext";

const audioQueue = new AudioQueue();
const MIN_TURN_MS = 600;
const SILENCE_MS = 900;
const VAD_THRESHOLD_DB = -50; // meter level; closer to 0 is louder; lowered to catch quieter speech
const POLL_INTERVAL_MS = 120;
const MAX_LISTEN_MS = 8000;

export default function ConversationScreen() {
  const router = useRouter();
  const {
    personaId,
    conversationId,
    startConversation,
    addMessage,
    messages,
    streamingText,
    appendStreamingText,
    clearStreamingText,
    setQueue,
    setRecording,
    setPlaying,
    isRecording,
    isPlaying,
    resetSession
  } = useSessionStore();

  const persona = personas.find((p) => p.id === personaId);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const recordingPrepareRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const bufferRef = useRef<string>("");
  const callActiveRef = useRef(false);
  const listeningRef = useRef(false);
  const [callActive, setCallActive] = useState(false);
  const wsRef = useRef<VoiceWsClient | null>(null);
  const { colors } = useTheme();
  const styles = useMemo(
    () => createStyles(colors, isRecording, isPlaying),
    [colors, isRecording, isPlaying]
  );

  useEffect(() => {
    if (!personaId) {
      router.replace("/");
    }
  }, [personaId, router]);

  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  const ensureConversation = () => {
    if (!conversationId) {
      startConversation(uuidv4());
    }
  };

  const startRecording = async () => {
    if (recordingPrepareRef.current || recordingRef.current || isRecording) return null;
    recordingPrepareRef.current = true;
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true
      });
      const recording = new Audio.Recording();
      // Enable metering to allow simple VAD.
      const options: Audio.RecordingOptions = {
        android: {
          extension: ".m4a",
          outputFormat: Audio.RECORDING_OPTION_ANDROID_OUTPUT_FORMAT_MPEG_4,
          audioEncoder: Audio.RECORDING_OPTION_ANDROID_AUDIO_ENCODER_AAC,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 128000
        },
        ios: {
          extension: ".m4a",
          audioQuality: Audio.RECORDING_OPTION_IOS_AUDIO_QUALITY_HIGH,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 128000,
          outputFormat: Audio.RECORDING_OPTION_IOS_OUTPUT_FORMAT_MPEG4AAC,
          meteringEnabled: true
        },
        web: {
          mimeType: "audio/webm"
        }
      };
      await recording.prepareToRecordAsync(options);
      await recording.startAsync();
      recordingRef.current = recording;
      setRecording(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return recording;
    } finally {
      recordingPrepareRef.current = false;
    }
  };

  const stopRecording = async () => {
    const recording = recordingRef.current;
    if (!recording) return null;
    await recording.stopAndUnloadAsync();
    const uri = recording.getURI();
    recordingRef.current = null;
    setRecording(false);
    if (!uri) return null;
    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: "base64"
    });
    return base64;
  };

  const saveBase64Audio = async (base64: string, mime: string) => {
    const ext = mime.includes("wav") ? "wav" : mime.includes("webm") ? "webm" : "mp3";
    const path = `${FileSystem.cacheDirectory}tts-${uuidv4()}.${ext}`;
    await FileSystem.writeAsStringAsync(path, base64, { encoding: "base64" });
    return path;
  };

  const enqueueSentences = async (sentences: string[]) => {
    for (const sentence of sentences) {
      try {
        const audioBuf = await synthesizeTts(sentence, persona?.voice);
        const path = await cacheTtsToFile(uuidv4(), audioBuf);
        audioQueue.enqueue({ id: uuidv4(), uri: path, text: sentence });
        setQueue(audioQueue.items());
        if (!audioQueue.isEmpty()) {
          setPlaying(true);
          await audioQueue.playNext(() => {
            setQueue(audioQueue.items());
            setPlaying(!audioQueue.isEmpty());
          });
        }
      } catch (err) {
        console.warn("TTS failed", err);
      }
    }
  };

  const stopAllAudio = async () => {
    callActiveRef.current = false;
    setCallActive(false);
    listeningRef.current = false;
    abortRef.current?.abort();
    wsRef.current?.stop();
    wsRef.current = null;
    if (recordingRef.current) {
      try {
        await recordingRef.current.stopAndUnloadAsync();
      } catch {
        // ignore
      }
      recordingRef.current = null;
    }
    setRecording(false);
    await audioQueue.stop();
    audioQueue.clear();
    setQueue([]);
    setPlaying(false);
    clearStreamingText();
  };

  const handleSendChunk = async (base64: string, heardVoice: boolean, info?: { durationMs?: number }) => {
    try {
      const minLen = 200; // avoid sending empty/too-short payloads
      if (!heardVoice || !base64 || base64.length < minLen) {
        console.log("[voice] drop send (no audio)", { heardVoice, len: base64?.length, info });
        Alert.alert("Conversation failed", "No audio detected. Please try again.");
        return;
      }
      console.log("[voice] send chunk", { len: base64.length, heardVoice, info });
      ensureConversation();
      const userMessage: Message = {
        id: uuidv4(),
        role: "user",
        text: "[voice message]",
        createdAt: new Date().toISOString()
      };
      addMessage(userMessage);

      const ws = wsRef.current;
      if (ws) {
        // Expo HIGH_QUALITY records m4a (AAC) on iOS; Deepgram expects audio/mp4.
        ws.sendAudio(uuidv4(), "audio/mp4", base64);
      } else {
        Alert.alert("Conversation failed", "Voice channel not connected");
      }
    } catch (err: any) {
      Alert.alert("Conversation failed", err?.message ?? String(err));
    }
  };

  const startListeningForTurn = useCallback(async () => {
    if (listeningRef.current || isPlaying || !callActiveRef.current) return;
    listeningRef.current = true;
    try {
      ensureConversation();
      const recording = await startRecording();
      if (!recording) {
        listeningRef.current = false;
        return;
      }
      let heardVoice = false;
      let lastVoiceAt = Date.now();
      let lastLevel = -160;
      const startedAt = Date.now();
      let lastDuration = 0;
      while (callActiveRef.current && !isPlaying) {
        const status = await recording.getStatusAsync();
        const hasMeter = typeof status.metering === "number";
        const level = hasMeter ? (status.metering as number) : lastLevel;
        lastLevel = level;
        if (hasMeter) {
          console.log("[voice] meter", { level });
          if (level > VAD_THRESHOLD_DB) {
            if (!heardVoice) console.log("[voice] heardVoice flip", { level });
            heardVoice = true;
            lastVoiceAt = Date.now();
          }
        }
        const duration = status.durationMillis ?? 0;
        lastDuration = duration;
        const sinceVoice = Date.now() - lastVoiceAt;
        // Simulator often reports no metering; fall back to a duration-based send to avoid stalling.
        if (!hasMeter && duration > MIN_TURN_MS + SILENCE_MS) {
          const base64 = await stopRecording();
          if (base64) {
            await handleSendChunk(base64, true, { durationMs: duration });
          } else {
            console.log("[voice] drop (no base64, no meter)", { duration });
          }
          return;
        }
        if (heardVoice && sinceVoice > SILENCE_MS && duration > MIN_TURN_MS) {
          const base64 = await stopRecording();
          if (base64) {
            await handleSendChunk(base64, heardVoice, { durationMs: duration });
          } else {
            console.log("[voice] drop (no base64 after voice)", { duration });
          }
          return;
        }
        if (!heardVoice && Date.now() - startedAt > MAX_LISTEN_MS) {
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }
      const base64 = await stopRecording().catch(() => null);
      if (base64 && (heardVoice || lastDuration > MIN_TURN_MS + SILENCE_MS)) {
        await handleSendChunk(base64, heardVoice || false, { durationMs: lastDuration });
      } else {
        console.log("[voice] drop post-loop", { heardVoice, durationMs: lastDuration, hasBase64: !!base64 });
      }
    } catch (err) {
      console.warn("Listen loop failed", err);
      await stopRecording().catch(() => null);
    } finally {
      listeningRef.current = false;
    }
  }, [handleSendChunk, isPlaying, startRecording]);

  const handleTap = async () => {
    if (callActive) {
      await handleEndConversation();
      return;
    }
    if (!personaId) {
      Alert.alert("Select a persona first");
      return;
    }

    const ws = new VoiceWsClient({
      onText: (text) => {
        appendStreamingText(text);
        const { sentences, remainder } = splitBufferedText(bufferRef.current + text);
        bufferRef.current = remainder;
        if (sentences.length) {
          const aiMessage: Message = {
            id: uuidv4(),
            role: "ai",
            text: sentences.join(" "),
            createdAt: new Date().toISOString()
          };
          addMessage(aiMessage);
          enqueueSentences(sentences);
          clearStreamingText();
        }
      },
      onTts: async ({ base64, mime }) => {
        try {
          const path = await saveBase64Audio(base64, mime);
          audioQueue.enqueue({ id: uuidv4(), uri: path, text: "" });
          setQueue(audioQueue.items());
          if (!audioQueue.isEmpty()) {
            setPlaying(true);
            await audioQueue.playNext(() => {
              setQueue(audioQueue.items());
              setPlaying(!audioQueue.isEmpty());
            });
          }
        } catch (err) {
          console.warn("TTS playback failed", err);
        }
      },
      onStatus: (value) => {
        // could map to UI status if desired
      },
      onError: (message) => Alert.alert("Conversation failed", message)
    });

    ws.connect({ personaId, conversationId: conversationId ?? undefined });
    wsRef.current = ws;

    callActiveRef.current = true;
    setCallActive(true);
    startListeningForTurn();
  };

  const handleEndConversation = async () => {
    await stopAllAudio();
    await persistTranscript();
    resetSession();
  };

  useEffect(() => {
    if (callActive && !isPlaying && !listeningRef.current) {
      startListeningForTurn();
    }
  }, [callActive, isPlaying, startListeningForTurn]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        // Ensure nothing keeps running if the user navigates away.
        stopAllAudio();
      };
    }, [])
  );

  const persistTranscript = async () => {
    if (!messages.length) return;
    const transcriptId = conversationId ?? uuidv4();
    const entry = {
      id: transcriptId,
      createdAt: new Date().toISOString(),
      messages,
      personaId: personaId ?? persona?.id,
      durationSec: messages.length * 25
    };
    const raw = await AsyncStorage.getItem("transcripts");
    const existing = raw ? (JSON.parse(raw) as typeof entry[]) : [];
    const next = [entry, ...existing].slice(0, 50);
    await AsyncStorage.setItem("transcripts", JSON.stringify(next));
  };

  const hasActiveConversation = callActive || isPlaying || messages.length > 0 || !!streamingText;

  return (
    <View style={styles.container}>
      <View style={styles.hero}>
        <View>
          <Text style={styles.eyebrow}>Live with</Text>
          <Text style={styles.persona}>{persona?.name}</Text>
          <Text style={styles.role}>{persona?.role}</Text>
        </View>
        <View style={styles.heroRight}>
          <View style={styles.statusPill}>
            <Text style={styles.statusText}>
              {isRecording ? "Listening" : isPlaying ? "Speaking" : "Ready"}
            </Text>
          </View>
        </View>
      </View>

      <VoiceGlow active={isRecording || isPlaying} color={colors.primary} />

      <View style={styles.liveBox}>
        <Text style={styles.sectionLabel}>Live transcript</Text>
        <ScrollView style={{ maxHeight: 140 }}>
          <Text style={styles.liveText}>{streamingText || "Waiting for a response…"}</Text>
        </ScrollView>
      </View>

      <View style={styles.conversationBox}>
        <Text style={styles.sectionLabel}>Conversation</Text>
        <ScrollView style={{ maxHeight: 260 }}>
          {messages.map((m) => (
            <View
              key={m.id}
              style={[
                styles.messageBubble,
                m.role === "ai" ? styles.aiBubble : styles.userBubble
              ]}
            >
              <Text
                style={[
                  styles.messageMeta,
                  m.role === "user" && styles.messageMetaUser
                ]}
              >
                {m.role === "ai" ? "AI" : "You"}
              </Text>
              <Text
                style={[
                  styles.messageText,
                  m.role === "user" && styles.messageTextUser
                ]}
              >
                {m.text}
              </Text>
            </View>
          ))}
          {!messages.length ? <Text style={styles.placeholder}>No messages yet.</Text> : null}
        </ScrollView>
      </View>

      {!callActive && (
        <Pressable
          style={[styles.mic, isRecording && styles.micActive]}
          onPress={handleTap}
        >
          <Text style={styles.micText}>Start call</Text>
        </Pressable>
      )}

      {(callActive || hasActiveConversation) && (
        <Pressable style={styles.endButton} onPress={handleEndConversation}>
          <Text style={styles.endText}>End conversation</Text>
        </Pressable>
      )}
    </View>
  );
}

function VoiceGlow({ active, color }: { active: boolean; color: string }) {
  const ringA = useRef(new Animated.Value(0.8)).current;
  const ringB = useRef(new Animated.Value(1.1)).current;
  const opacityA = useRef(new Animated.Value(0.6)).current;
  const opacityB = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    const loopA = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(ringA, { toValue: 1.4, duration: 900, useNativeDriver: true }),
          Animated.timing(opacityA, { toValue: 0, duration: 900, useNativeDriver: true })
        ]),
        Animated.timing(ringA, { toValue: 0.8, duration: 0, useNativeDriver: true }),
        Animated.timing(opacityA, { toValue: 0.6, duration: 0, useNativeDriver: true })
      ])
    );
    const loopB = Animated.loop(
      Animated.sequence([
        Animated.delay(300),
        Animated.parallel([
          Animated.timing(ringB, { toValue: 1.6, duration: 1100, useNativeDriver: true }),
          Animated.timing(opacityB, { toValue: 0, duration: 1100, useNativeDriver: true })
        ]),
        Animated.timing(ringB, { toValue: 1.1, duration: 0, useNativeDriver: true }),
        Animated.timing(opacityB, { toValue: 0.4, duration: 0, useNativeDriver: true })
      ])
    );

    if (active) {
      loopA.start();
      loopB.start();
    } else {
      loopA.stop();
      loopB.stop();
      ringA.setValue(0.8);
      ringB.setValue(1.1);
      opacityA.setValue(0.6);
      opacityB.setValue(0.4);
    }

    return () => {
      loopA.stop();
      loopB.stop();
    };
  }, [active, ringA, ringB, opacityA, opacityB]);

  return (
    <View style={stylesShared.glowWrap}>
      <Animated.View
        style={[
          stylesShared.glowRing,
          {
            backgroundColor: color,
            transform: [{ scale: ringA }],
            opacity: opacityA
          }
        ]}
      />
      <Animated.View
        style={[
          stylesShared.glowRing,
          {
            backgroundColor: color,
            transform: [{ scale: ringB }],
            opacity: opacityB
          }
        ]}
      />
      <View style={[stylesShared.glowCore, { backgroundColor: color }]} />
    </View>
  );
}

const stylesShared = StyleSheet.create({
  glowWrap: {
    alignItems: "center",
    justifyContent: "center",
    height: 140
  },
  glowRing: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60
  },
  glowCore: {
    width: 56,
    height: 56,
    borderRadius: 28,
    opacity: 0.9,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 12
  }
});

const createStyles = (
  colors: ReturnType<typeof useTheme>["colors"],
  isRecording: boolean,
  isPlaying: boolean
) =>
  StyleSheet.create({
    container: {
      flex: 1,
      padding: 18,
      paddingBottom: 32,
      gap: 12,
      backgroundColor: colors.background
    },
    hero: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 16,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center"
    },
    heroRight: {
      alignItems: "flex-end",
      gap: 8
    },
    eyebrow: { color: colors.textMuted, fontWeight: "700", letterSpacing: 0.3 },
    persona: { color: colors.textMain, fontSize: 22, fontWeight: "800" },
    role: { color: colors.textMuted },
    statusPill: {
      backgroundColor: isRecording ? colors.primary : colors.surface,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 20,
      borderWidth: 1,
      borderColor: colors.border
    },
    statusText: {
      color: isRecording ? colors.primaryText : colors.textMain,
      fontWeight: "700"
    },
    liveBox: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14
    },
    sectionLabel: { color: colors.textMuted, fontWeight: "700", marginBottom: 8 },
    liveText: { color: colors.textMain, lineHeight: 20 },
    conversationBox: {
      flex: 1,
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      gap: 8
    },
    messageBubble: {
      borderRadius: 14,
      padding: 12,
      marginBottom: 8,
      borderWidth: 1
    },
    aiBubble: {
      backgroundColor: colors.surface,
      borderColor: colors.border
    },
    userBubble: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
      alignSelf: "flex-start"
    },
    messageMeta: {
      fontSize: 12,
      color: colors.textMuted,
      marginBottom: 4
    },
    messageText: {
      color: colors.textMain,
      lineHeight: 20
    },
    messageTextUser: {
      color: colors.primaryText
    },
    messageMetaUser: {
      color: colors.primaryText
    },
    placeholder: {
      color: colors.textMuted,
      textAlign: "center",
      marginTop: 12
    },
    mic: {
      backgroundColor: colors.primary,
      paddingVertical: 16,
      borderRadius: 14,
      alignItems: "center"
    },
    micActive: {
      opacity: 0.9
    },
    micText: {
      color: colors.primaryText,
      fontWeight: "800",
      fontSize: 16
    },
    endButton: {
      paddingVertical: 14,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      alignItems: "center"
    },
    endText: {
      color: colors.textMain,
      fontWeight: "700"
    }
  });

