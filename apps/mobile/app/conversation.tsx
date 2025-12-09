import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ScrollView, Animated } from "react-native";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { v4 as uuidv4 } from "uuid";
import { useAudioRecorder } from "@siteed/expo-audio-studio";
import { personas } from "../src/constants/personas";
import { VoiceWsClient } from "../src/api/voiceWs";
import { splitBufferedText } from "../src/utils/sentenceSplitter";
import { AudioQueue } from "../src/utils/audioQueue";
import { useSessionStore } from "../src/state/useSessionStore";
import { Message } from "../src/types";
import { useTheme } from "../src/context/ThemeContext";

const audioQueue = new AudioQueue();

// Streaming audio config for Deepgram
const STREAM_SAMPLE_RATE = 16000;
const STREAM_CHANNELS = 1;
const STREAM_ENCODING = "pcm_16bit";
const STREAM_INTERVAL_MS = 100; // Send chunk every 100ms

// VAD/Silence detection
const SILENCE_MS = 1200; // End turn after 1.2s of silence
const MIN_SPEECH_MS = 500; // Minimum speech duration before considering it a valid turn
const VAD_THRESHOLD = 0.02; // RMS threshold for voice activity

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
  const bufferRef = useRef<string>("");
  const callActiveRef = useRef(false);
  const [callActive, setCallActive] = useState(false);
  const wsRef = useRef<VoiceWsClient | null>(null);
  const { colors } = useTheme();
  
  // Voice activity tracking for turn detection
  const lastVoiceActivityRef = useRef<number>(0);
  const speechStartedRef = useRef<number>(0);
  const hasSpeechRef = useRef(false);
  const silenceCheckIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamActiveRef = useRef(false);

  // Use the streaming audio recorder
  const {
    startRecording: startStreamRecording,
    stopRecording: stopStreamRecording,
    isRecording: isStreamRecording,
  } = useAudioRecorder();

  const styles = useMemo(
    () => createStyles(colors, isRecording || isStreamRecording, isPlaying),
    [colors, isRecording, isStreamRecording, isPlaying]
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

  const saveBase64Audio = async (base64: string, mime: string) => {
    const ext = mime.includes("wav") ? "wav" : mime.includes("webm") ? "webm" : "mp3";
    const path = `${FileSystem.cacheDirectory}tts-${uuidv4()}.${ext}`;
    await FileSystem.writeAsStringAsync(path, base64, { encoding: "base64" });
    return path;
  };

  // Handle incoming audio stream data from the recorder
  const handleAudioStream = useCallback(async (event: { data: string | Float32Array; position?: number; eventDataSize?: number }) => {
    const ws = wsRef.current;
    if (!ws || !callActiveRef.current || !streamActiveRef.current) return;

    // Get the base64 encoded audio data
    // The data can be either base64 string or Float32Array depending on platform/config
    let base64Data: string;
    if (typeof event.data === "string") {
      base64Data = event.data;
    } else {
      // Convert Float32Array to base64 (PCM 16-bit)
      const pcm16 = new Int16Array(event.data.length);
      for (let i = 0; i < event.data.length; i++) {
        const s = Math.max(-1, Math.min(1, event.data[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      const uint8 = new Uint8Array(pcm16.buffer);
      // Use btoa for base64 encoding
      let binary = "";
      for (let i = 0; i < uint8.length; i++) {
        binary += String.fromCharCode(uint8[i]);
      }
      base64Data = btoa(binary);
    }

    if (!base64Data || base64Data.length < 10) return;

    // Send chunk to server
    ws.sendAudioChunk(base64Data);

    // Update voice activity tracking
    const now = Date.now();
    if (event.eventDataSize && event.eventDataSize > 0) {
      // If we're getting data, assume activity
      lastVoiceActivityRef.current = now;
      if (!hasSpeechRef.current) {
        hasSpeechRef.current = true;
        speechStartedRef.current = now;
      }
    }
  }, []);

  // Start streaming audio to the server
  const startAudioStream = useCallback(async () => {
    if (streamActiveRef.current || isPlaying) return;

    try {
      // Request permissions
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        Alert.alert("Permission required", "Microphone access is needed for voice calls");
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true
      });

      // Tell server we're starting an audio stream
      const ws = wsRef.current;
      if (ws) {
        ws.startAudioStream({
          sampleRate: STREAM_SAMPLE_RATE,
          channels: STREAM_CHANNELS,
          encoding: STREAM_ENCODING
        });
      }

      // Reset VAD state
      hasSpeechRef.current = false;
      speechStartedRef.current = 0;
      lastVoiceActivityRef.current = Date.now();
      streamActiveRef.current = true;

      // Start the audio recorder with streaming config
      await startStreamRecording({
        sampleRate: STREAM_SAMPLE_RATE,
        channels: STREAM_CHANNELS,
        encoding: STREAM_ENCODING as "pcm_16bit",
        interval: STREAM_INTERVAL_MS,
        enableProcessing: true,
        keepAwake: true,
        onAudioStream: handleAudioStream,
        onAudioAnalysis: async (data) => {
          // Use amplitude/energy data for VAD if available
          // The AudioAnalysisEvent may have different properties depending on version
          const analysisData = data as { amplitude?: number; energy?: number };
          const level = analysisData.amplitude ?? analysisData.energy ?? 0;
          if (level > VAD_THRESHOLD) {
            lastVoiceActivityRef.current = Date.now();
            if (!hasSpeechRef.current) {
              hasSpeechRef.current = true;
              speechStartedRef.current = Date.now();
            }
          }
        }
      });

      setRecording(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

      // Start silence detection interval
      silenceCheckIntervalRef.current = setInterval(() => {
        if (!streamActiveRef.current || isPlaying) return;

        const now = Date.now();
        const silenceDuration = now - lastVoiceActivityRef.current;
        const speechDuration = hasSpeechRef.current ? now - speechStartedRef.current : 0;

        // If we've had speech and silence exceeds threshold, end the turn
        if (hasSpeechRef.current && silenceDuration > SILENCE_MS && speechDuration > MIN_SPEECH_MS) {
          endAudioStreamAndProcess();
        }
      }, 100);

    } catch (err) {
      console.warn("Failed to start audio stream", err);
      streamActiveRef.current = false;
      setRecording(false);
    }
  }, [isPlaying, startStreamRecording, handleAudioStream]);

  // End audio stream and trigger processing
  const endAudioStreamAndProcess = useCallback(async () => {
    if (!streamActiveRef.current) return;

    streamActiveRef.current = false;

    // Clear silence check interval
    if (silenceCheckIntervalRef.current) {
      clearInterval(silenceCheckIntervalRef.current);
      silenceCheckIntervalRef.current = null;
    }

    try {
      await stopStreamRecording();
    } catch (err) {
      console.warn("Error stopping recording", err);
    }

    setRecording(false);

    // Tell server audio stream ended (triggers transcription)
    const ws = wsRef.current;
    if (ws && hasSpeechRef.current) {
      ws.endAudioStream();
      
      // Add placeholder message
      ensureConversation();
      const userMessage: Message = {
        id: uuidv4(),
        role: "user",
        text: "[voice message]",
        createdAt: new Date().toISOString()
      };
      addMessage(userMessage);
    }

    // Reset VAD state
    hasSpeechRef.current = false;
    speechStartedRef.current = 0;
  }, [stopStreamRecording, addMessage]);

  const stopAllAudio = useCallback(async () => {
    callActiveRef.current = false;
    setCallActive(false);
    streamActiveRef.current = false;

    // Clear silence check interval
    if (silenceCheckIntervalRef.current) {
      clearInterval(silenceCheckIntervalRef.current);
      silenceCheckIntervalRef.current = null;
    }

    wsRef.current?.stop();
    wsRef.current = null;

    try {
      await stopStreamRecording();
    } catch {
      // ignore
    }

    setRecording(false);
    await audioQueue.stop();
    audioQueue.clear();
    setQueue([]);
    setPlaying(false);
    clearStreamingText();
  }, [stopStreamRecording, setQueue, setPlaying, setRecording, clearStreamingText]);

  const handleTap = async () => {
    if (callActive) {
      await handleEndConversation();
      return;
    }
    if (!personaId) {
      Alert.alert("Select a persona first");
      return;
    }

    ensureConversation();

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
              const stillPlaying = !audioQueue.isEmpty();
              setPlaying(stillPlaying);
              
              // Restart listening when done playing
              if (!stillPlaying && callActiveRef.current) {
                setTimeout(() => startAudioStream(), 200);
              }
            });
          }
        } catch (err) {
          console.warn("TTS playback failed", err);
        }
      },
      onStatus: (value) => {
        // Handle status updates if needed
        if (value === "speaking") {
          // Server is about to send TTS
        } else if (value === "listening" || value === "ready") {
          // Server is ready for more input
        }
      },
      onError: (message) => Alert.alert("Conversation failed", message),
      onTranscript: (text) => {
        // Update the user message with actual transcript
        // This is sent by the server after STT completes
        console.log("[conversation] transcript received:", text);
      }
    });

    ws.connect({ personaId, conversationId: conversationId ?? undefined });
    wsRef.current = ws;

    callActiveRef.current = true;
    setCallActive(true);

    // Start streaming audio
    setTimeout(() => startAudioStream(), 500);
  };

  const handleEndConversation = async () => {
    await stopAllAudio();
    await persistTranscript();
    resetSession();
  };

  // Restart listening when not playing and call is active
  useEffect(() => {
    if (callActive && !isPlaying && !isStreamRecording && !streamActiveRef.current) {
      const timer = setTimeout(() => {
        if (callActiveRef.current && !isPlaying) {
          startAudioStream();
        }
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [callActive, isPlaying, isStreamRecording, startAudioStream]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        // Ensure nothing keeps running if the user navigates away.
        stopAllAudio();
      };
    }, [stopAllAudio])
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
              {isStreamRecording || isRecording ? "Listening" : isPlaying ? "Speaking" : "Ready"}
            </Text>
          </View>
        </View>
      </View>

      <VoiceGlow active={isStreamRecording || isRecording || isPlaying} color={colors.primary} />

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
          style={[styles.mic, (isRecording || isStreamRecording) && styles.micActive]}
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
