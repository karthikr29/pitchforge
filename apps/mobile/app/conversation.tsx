import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, StyleSheet, Alert, ScrollView, Animated } from "react-native";
import { Audio } from "expo-av";
import { AndroidOutputFormat, AndroidAudioEncoder, IOSOutputFormat, IOSAudioQuality } from "expo-av/build/Audio";
import * as FileSystem from "expo-file-system/legacy";
import * as Haptics from "expo-haptics";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { v4 as uuidv4 } from "uuid";
import { personas } from "../src/constants/personas";
import { VoiceWsClient } from "../src/api/voiceWs";
import { splitBufferedText } from "../src/utils/sentenceSplitter";
import { AudioQueue } from "../src/utils/audioQueue";
import { useSessionStore } from "../src/state/useSessionStore";
import { Message } from "../src/types";
import { useTheme } from "../src/context/ThemeContext";

const audioQueue = new AudioQueue();

// VAD (Voice Activity Detection) configuration
// These settings control when the app thinks you've finished speaking
const SILENCE_MS = 2000;        // End turn after 2s of silence (was 1s - too aggressive!)
const VAD_THRESHOLD_DB = -45;   // Threshold for voice detection (-45dB is reasonable for speech)
const MAX_LISTEN_MS = 30000;    // Max 30s per turn (allows for longer responses)
const MIN_TURN_MS = 800;        // Minimum 800ms of speech before considering a turn valid
const MIN_SPEECH_BEFORE_SILENCE = 1500; // Must have at least 1.5s of speech before silence can end turn

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
  const bufferRef = useRef<string>("");
  const callActiveRef = useRef(false);
  const listeningRef = useRef(false);
  const streamStartedRef = useRef(false);
  const accumulatedChunksRef = useRef<string[]>([]);
  const recordingFailureCountRef = useRef(0);
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
    if (recordingPrepareRef.current) {
      console.log("[conversation] recording already preparing, skipping");
      return null;
    }
    
    // Clean up any existing recording first
    if (recordingRef.current) {
      console.log("[conversation] cleaning up existing recording...");
      try {
        const status = await recordingRef.current.getStatusAsync();
        if (status.isRecording) {
          await recordingRef.current.stopAndUnloadAsync();
        }
      } catch (e) {
        // Ignore cleanup errors
      }
      recordingRef.current = null;
      setRecording(false);
    }
    
    recordingPrepareRef.current = true;
    try {
      // Request permissions
      console.log("[conversation] requesting permissions...");
      const permissionResponse = await Audio.requestPermissionsAsync();
      console.log("[conversation] permission response:", permissionResponse.status);
      
      if (!permissionResponse.granted) {
        console.warn("[conversation] microphone permission denied");
        Alert.alert("Permission Required", "Microphone access is needed for voice calls");
        return null;
      }
      
      // Set audio mode for recording
      console.log("[conversation] setting audio mode...");
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      
      // Use the recommended createAsync pattern with HIGH_QUALITY preset
      // This handles preparation automatically and is more reliable
      console.log("[conversation] creating recording with createAsync...");
      const { recording, status } = await Audio.Recording.createAsync(
        {
          isMeteringEnabled: true,
          android: {
            extension: ".m4a",
            outputFormat: AndroidOutputFormat.MPEG_4,
            audioEncoder: AndroidAudioEncoder.AAC,
            sampleRate: 44100,
            numberOfChannels: 1,
            bitRate: 128000
          },
          ios: {
            extension: ".m4a",
            audioQuality: IOSAudioQuality.HIGH,
            sampleRate: 44100,
            numberOfChannels: 1,
            bitRate: 128000,
            outputFormat: IOSOutputFormat.MPEG4AAC
          },
          web: {
            mimeType: "audio/webm"
          }
        },
        (recordingStatus) => {
          // Optional: handle recording status updates
        },
        100 // Update interval in ms
      );
      
      console.log("[conversation] recording created, status:", status.isRecording ? "recording" : "not recording");
      
      if (!status.isRecording) {
        console.warn("[conversation] recording created but not started");
        // Try to start it manually
        await recording.startAsync();
      }
      
      recordingRef.current = recording;
      setRecording(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      console.log("[conversation] recording started successfully");
      return recording;
    } catch (err: any) {
      console.warn("[conversation] startRecording failed:", err?.message || err);
      console.warn("[conversation] full error:", JSON.stringify(err, null, 2));
      // Clean up any partial state
      recordingRef.current = null;
      setRecording(false);
      return null;
    } finally {
      recordingPrepareRef.current = false;
    }
  };

  const stopRecording = async () => {
    const recording = recordingRef.current;
    if (!recording) {
      console.log("[conversation] stopRecording: no recording to stop");
      return null;
    }
    
    console.log("[conversation] stopping recording...");
    let uri: string | null = null;
    
    try {
      // Get URI before stopping (some versions need this)
      uri = recording.getURI();
      
      // Check status before stopping
      const status = await recording.getStatusAsync();
      console.log("[conversation] recording status before stop:", status.isRecording ? "recording" : "stopped");
      
      if (status.isRecording) {
        await recording.stopAndUnloadAsync();
        console.log("[conversation] recording stopped and unloaded");
      }
    } catch (err: any) {
      console.warn("[conversation] error stopping recording:", err?.message || err);
      // Try to get URI even if stop failed
      try {
        uri = recording.getURI();
      } catch {}
    }
    
    recordingRef.current = null;
    setRecording(false);
    
    // Reset audio mode back to playback
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
      });
    } catch {}
    
    if (!uri) {
      console.log("[conversation] no recording URI available");
      return null;
    }
    
    console.log("[conversation] reading recording from:", uri);
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: "base64"
      });
      console.log("[conversation] recording read, size:", base64.length);
      
      // Clean up the file
      try {
        await FileSystem.deleteAsync(uri, { idempotent: true });
      } catch {}
      
      return base64;
    } catch (err: any) {
      console.warn("[conversation] error reading recording:", err?.message || err);
      return null;
    }
  };

  const saveBase64Audio = async (base64: string, mime: string) => {
    const ext = mime.includes("wav") ? "wav" : mime.includes("webm") ? "webm" : "mp3";
    const path = `${FileSystem.cacheDirectory}tts-${uuidv4()}.${ext}`;
    await FileSystem.writeAsStringAsync(path, base64, { encoding: "base64" });
    return path;
  };

  const stopAllAudio = useCallback(async () => {
    callActiveRef.current = false;
    setCallActive(false);
    listeningRef.current = false;
    streamStartedRef.current = false;
    accumulatedChunksRef.current = [];
    recordingFailureCountRef.current = 0;
    
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
  }, [setQueue, setPlaying, setRecording, clearStreamingText]);

  // Send accumulated audio chunks to server
  const sendAccumulatedAudio = useCallback(async () => {
    const chunks = accumulatedChunksRef.current;
    accumulatedChunksRef.current = [];
    
    if (chunks.length === 0) return;
    
    const ws = wsRef.current;
    if (!ws) return;
    
    // For now, send the last/largest chunk which should have the most content
    // In a full implementation, we'd concatenate the audio on server side
    const largestChunk = chunks.reduce((a, b) => a.length > b.length ? a : b, "");
    
    if (largestChunk.length < 100) {
      console.log("[conversation] audio too short, skipping");
      return;
    }
    
    ensureConversation();
    const userMessage: Message = {
      id: uuidv4(),
      role: "user",
      text: "[voice message]",
      createdAt: new Date().toISOString()
    };
    addMessage(userMessage);
    
    // Send as legacy audio message (server handles it with REST API)
    ws.sendAudio(uuidv4(), "audio/mp4", largestChunk);
  }, [addMessage]);

  const startListeningForTurn = useCallback(async () => {
    if (listeningRef.current) {
      console.log("[conversation] already listening, skipping");
      return;
    }
    if (isPlaying) {
      console.log("[conversation] playing audio, skipping listen");
      return;
    }
    if (!callActiveRef.current) {
      console.log("[conversation] call not active, skipping listen");
      return;
    }
    
    listeningRef.current = true;
    streamStartedRef.current = false;
    accumulatedChunksRef.current = [];
    
    try {
      ensureConversation();
      
      // Reset audio mode before starting to record
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });
      } catch (err) {
        console.warn("[conversation] audio mode reset failed:", err);
      }
      
      console.log("[conversation] starting to listen for turn...");
      const recording = await startRecording();
      if (!recording) {
        console.warn("[conversation] failed to start recording, will retry after delay");
        listeningRef.current = false;
        // Don't immediately retry - the useEffect will retry with a delay
        return;
      }
      
      // Signal to server we're starting to stream (for potential future streaming support)
      const ws = wsRef.current;
      if (ws && ws.isConnected()) {
        ws.startAudioStream({
          sampleRate: 16000,
          channels: 1,
          encoding: "aac"
        });
        streamStartedRef.current = true;
      }
      
      let heardVoice = false;
      let lastVoiceAt = Date.now();
      let lastLevel = -160;
      const startedAt = Date.now();
      let totalSpeechTime = 0;  // Track cumulative speech time
      let speechStartTime = 0;  // When current speech segment started
      let isSpeaking = false;   // Is user currently speaking?
      
      console.log("[conversation] VAD config: SILENCE_MS=%d, VAD_THRESHOLD_DB=%d, MAX_LISTEN_MS=%d", 
        SILENCE_MS, VAD_THRESHOLD_DB, MAX_LISTEN_MS);
      
      while (callActiveRef.current && !isPlaying) {
        const status = await recording.getStatusAsync();
        const hasMeter = typeof status.metering === "number";
        const level = hasMeter ? (status.metering as number) : lastLevel;
        lastLevel = level;
        
        const now = Date.now();
        
        // Track speech segments for better turn detection
        if (hasMeter && level > VAD_THRESHOLD_DB) {
          if (!isSpeaking) {
            // Speech just started
            isSpeaking = true;
            speechStartTime = now;
          }
          heardVoice = true;
          lastVoiceAt = now;
        } else if (isSpeaking) {
          // Speech just ended - add to total
          totalSpeechTime += (now - speechStartTime);
          isSpeaking = false;
        }
        
        const duration = status.durationMillis ?? 0;
        const sinceVoice = now - lastVoiceAt;
        const sinceStart = now - startedAt;
        
        // Calculate current total speech (including ongoing speech)
        const currentTotalSpeech = totalSpeechTime + (isSpeaking ? (now - speechStartTime) : 0);
        
        // Simulator fallback: no metering, use duration-based trigger (longer timeout)
        if (!hasMeter && duration > MIN_TURN_MS + SILENCE_MS + 1000) {
          console.log("[conversation] ending turn (no metering fallback), duration=%dms", duration);
          const base64 = await stopRecording();
          if (base64) {
            accumulatedChunksRef.current.push(base64);
            await sendAccumulatedAudio();
          }
          if (ws && streamStartedRef.current) {
            ws.endAudioStream();
            streamStartedRef.current = false;
          }
          listeningRef.current = false;
          return;
        }
        
        // End turn on silence after sufficient speech
        // Must have: heard voice, silence > threshold, enough total recording, AND enough actual speech
        if (heardVoice && 
            sinceVoice > SILENCE_MS && 
            duration > MIN_TURN_MS && 
            currentTotalSpeech > MIN_SPEECH_BEFORE_SILENCE) {
          console.log("[conversation] ending turn (silence detected), sinceVoice=%dms, totalSpeech=%dms, duration=%dms", 
            sinceVoice, currentTotalSpeech, duration);
          const base64 = await stopRecording();
          if (base64) {
            accumulatedChunksRef.current.push(base64);
            await sendAccumulatedAudio();
          }
          if (ws && streamStartedRef.current) {
            ws.endAudioStream();
            streamStartedRef.current = false;
          }
          listeningRef.current = false;
          return;
        }
        
        // Max duration reached
        if (sinceStart > MAX_LISTEN_MS) {
          console.log("[conversation] ending turn (max duration), sinceStart=%dms, totalSpeech=%dms", 
            sinceStart, currentTotalSpeech);
          const base64 = await stopRecording();
          if (base64 && heardVoice) {
            accumulatedChunksRef.current.push(base64);
            await sendAccumulatedAudio();
          }
          if (ws && streamStartedRef.current) {
            ws.endAudioStream();
            streamStartedRef.current = false;
          }
          listeningRef.current = false;
          return;
        }
        
        await sleep(100);
      }
      
      // Clean up on exit
      const base64 = await stopRecording().catch(() => null);
      if (base64 && heardVoice) {
        accumulatedChunksRef.current.push(base64);
        await sendAccumulatedAudio();
      }
      if (wsRef.current && streamStartedRef.current) {
        wsRef.current.endAudioStream();
        streamStartedRef.current = false;
      }
    } catch (err) {
      console.warn("Listen loop failed", err);
      await stopRecording().catch(() => null);
      if (wsRef.current && streamStartedRef.current) {
        wsRef.current.endAudioStream();
        streamStartedRef.current = false;
      }
    } finally {
      listeningRef.current = false;
    }
  }, [isPlaying, sendAccumulatedAudio]);

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
                setTimeout(() => startListeningForTurn(), 200);
              }
            });
          }
        } catch (err) {
          console.warn("TTS playback failed", err);
        }
      },
      onStatus: (value) => {
        // Handle status updates if needed
      },
      onError: (message) => Alert.alert("Conversation failed", message),
      onTranscript: (text) => {
        // Update with actual transcript from server
        console.log("[conversation] transcript received:", text);
      }
    });

    ws.connect({ personaId, conversationId: conversationId ?? undefined });
    wsRef.current = ws;

    callActiveRef.current = true;
    setCallActive(true);

    // Start listening after a short delay
    setTimeout(() => startListeningForTurn(), 500);
  };

  const handleEndConversation = async () => {
    await stopAllAudio();
    await persistTranscript();
    resetSession();
  };

  // Restart listening when not playing and call is active
  useEffect(() => {
    if (callActive && !isPlaying && !listeningRef.current) {
      // Exponential backoff based on failure count (300ms, 600ms, 1200ms, etc., max 5s)
      const baseDelay = 300;
      const delay = Math.min(baseDelay * Math.pow(2, recordingFailureCountRef.current), 5000);
      
      console.log(`[conversation] scheduling listen retry in ${delay}ms (failures: ${recordingFailureCountRef.current})`);
      
      const timer = setTimeout(async () => {
        if (callActiveRef.current && !isPlaying && !listeningRef.current) {
          await startListeningForTurn();
          
          // If we're still not listening after the call, increment failure count
          if (!listeningRef.current && callActiveRef.current) {
            recordingFailureCountRef.current = Math.min(recordingFailureCountRef.current + 1, 5);
          } else {
            // Reset failure count on success
            recordingFailureCountRef.current = 0;
          }
        }
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [callActive, isPlaying, startListeningForTurn]);

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
