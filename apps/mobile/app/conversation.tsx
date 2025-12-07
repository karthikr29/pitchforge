import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ScrollView, Animated } from "react-native";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { v4 as uuidv4 } from "uuid";
import { personas } from "../src/constants/personas";
import { streamVoiceSession, synthesizeTts } from "../src/api/client";
import { splitBufferedText } from "../src/utils/sentenceSplitter";
import { AudioQueue, cacheTtsToFile } from "../src/utils/audioQueue";
import { useSessionStore } from "../src/state/useSessionStore";
import { Message } from "../src/types";
import { useTheme } from "../src/context/ThemeContext";

const audioQueue = new AudioQueue();

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
  const abortRef = useRef<AbortController | null>(null);
  const bufferRef = useRef<string>("");
  const [loading, setLoading] = useState(false);
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

  const ensureConversation = () => {
    if (!conversationId) {
      startConversation(uuidv4());
    }
  };

  const startRecording = async () => {
    if (recordingRef.current || isRecording) return;
    await Audio.requestPermissionsAsync();
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true
    });
    const recording = new Audio.Recording();
    await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    await recording.startAsync();
    recordingRef.current = recording;
    setRecording(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
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
      encoding: FileSystem.EncodingType.Base64
    });
    return base64;
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

  const handleSend = async () => {
    try {
      setLoading(true);
      ensureConversation();
      const base64 = await stopRecording();
      if (!base64) return;
      const userMessage: Message = {
        id: uuidv4(),
        role: "user",
        text: "[voice message]",
        createdAt: new Date().toISOString()
      };
      addMessage(userMessage);

      abortRef.current = new AbortController();
      const signal = abortRef.current.signal;
      bufferRef.current = "";

      await streamVoiceSession(
        {
          audioBase64: base64,
          personaId: personaId!,
          conversationId: conversationId ?? undefined
        },
        {
          signal,
          onText: async (chunk) => {
            appendStreamingText(chunk.text);
            const { sentences, remainder } = splitBufferedText(bufferRef.current + chunk.text);
            bufferRef.current = remainder;
            if (sentences.length) {
              const aiMessage: Message = {
                id: uuidv4(),
                role: "ai",
                text: sentences.join(" "),
                createdAt: new Date().toISOString()
              };
              addMessage(aiMessage);
              await enqueueSentences(sentences);
              clearStreamingText();
            }
          },
          onError: (message) => Alert.alert("Stream error", message),
          onDone: () => {
            clearStreamingText();
            setLoading(false);
          }
        }
      );
    } catch (err: any) {
      Alert.alert("Conversation failed", err?.message ?? String(err));
      setLoading(false);
    }
  };

  const handleTap = async () => {
    if (isRecording) {
      await handleSend();
    } else {
      await startRecording();
    }
  };

  const handleInterrupt = async () => {
    abortRef.current?.abort();
    await audioQueue.stop();
    audioQueue.clear();
    setQueue([]);
    setPlaying(false);
    clearStreamingText();
    setRecording(false);
  };

  const handleEndConversation = async () => {
    await handleInterrupt();
    await persistTranscript();
    resetSession();
    router.replace("/");
  };

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

      <Pressable
        style={[styles.mic, isRecording && styles.micActive]}
        onPress={handleTap}
        disabled={loading}
      >
        <Text style={styles.micText}>{isRecording ? "Listening… tap to send" : "Tap to Talk"}</Text>
      </Pressable>

      <Pressable style={styles.endButton} onPress={handleEndConversation}>
        <Text style={styles.endText}>End conversation</Text>
      </Pressable>
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


