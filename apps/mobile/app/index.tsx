import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, FlatList, StyleSheet, Pressable, ScrollView } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import { PersonaCard } from "../src/components/PersonaCard";
import { personas } from "../src/constants/personas";
import { useSessionStore } from "../src/state/useSessionStore";
import { fetchMinutes } from "../src/api/client";
import { useTheme } from "../src/context/ThemeContext";
import { Message } from "../src/types";
import { Ionicons } from "@expo/vector-icons";

export default function HomeScreen() {
  const router = useRouter();
  const { personaId, setPersona, remainingMinutes, setRemainingMinutes, favorites, toggleFavorite } =
    useSessionStore();
  const [loadingMinutes, setLoadingMinutes] = useState(false);
  const [history, setHistory] = useState<TranscriptEntry[]>([]);
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  const loadHistory = useCallback(async () => {
    const raw = await AsyncStorage.getItem("transcripts");
    if (!raw) {
      setHistory([]);
      return;
    }
    const parsed: TranscriptEntry[] = JSON.parse(raw);
    setHistory(parsed.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setLoadingMinutes(true);
        const mins = await fetchMinutes();
        setRemainingMinutes(mins);
      } catch (err) {
        // swallow for now; UI shows unknown
      } finally {
        setLoadingMinutes(false);
      }
    })();
  }, [setRemainingMinutes]);

  useFocusEffect(
    useCallback(() => {
      loadHistory();
    }, [loadHistory])
  );

  const hasFavorites = favorites.length > 0;

  return (
    <View style={styles.container}>
      <View style={[styles.section, styles.topSection]}>
        {hasFavorites ? (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>Favorites</Text>
            </View>
            <FlatList
              data={personas.filter((p) => favorites.includes(p.id))}
              horizontal
              keyExtractor={(item) => item.id}
              showsHorizontalScrollIndicator={false}
              renderItem={({ item }) => (
                <PersonaCard
                  persona={item}
                  selected={item.id === personaId}
                  onSelect={setPersona}
                  favorite
                  onToggleFavorite={toggleFavorite}
                />
              )}
              contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
              style={{ flexGrow: 0 }}
            />
          </>
        ) : null}

        <View style={[styles.rowHeader, hasFavorites && { marginTop: 4 }]}>
          <Text style={styles.sectionLabel}>Personas</Text>
          <Pressable onPress={() => router.push("/personas")} hitSlop={8} style={styles.rowLink}>
            <Text style={styles.rowLinkText}>View all</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textMain} />
          </Pressable>
        </View>
        <Text style={[styles.sectionSubtitle, { paddingHorizontal: 12 }]}>
          Pick who to practice with
        </Text>

        <FlatList
          data={personas}
          horizontal
          keyExtractor={(item) => item.id}
          showsHorizontalScrollIndicator={false}
          renderItem={({ item }) => (
            <PersonaCard
              persona={item}
              selected={item.id === personaId}
              onSelect={setPersona}
              favorite={favorites.includes(item.id)}
              onToggleFavorite={toggleFavorite}
            />
          )}
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 12 }}
          style={{ flexGrow: 0 }}
        />

        <Pressable
          disabled={!personaId}
          style={[styles.callButton, !personaId && styles.callButtonDisabled]}
          onPress={() => router.push("/conversation")}
        >
          <Text style={styles.callText}>
            {personaId
              ? `Call ${personas.find((p) => p.id === personaId)?.name}`
              : "Select Persona"}
          </Text>
        </Pressable>
      </View>

      <View style={[styles.section, styles.historySection]}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>Call History</Text>
          <Text style={styles.subtitle}>Recent sessions</Text>
        </View>
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8 }}
          style={{ flex: 1 }}
        >
          {history.length === 0 ? (
            <Text style={styles.empty}>No history yet.</Text>
          ) : (
            history.map((item) => (
              <View key={item.id} style={{ marginBottom: 10 }}>
                <HistoryCard
                  entry={item}
                  onPress={() => router.push(`/history/${item.id}`)}
                />
              </View>
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

type TranscriptEntry = {
  id: string;
  createdAt: string;
  messages: Message[];
  personaId?: string;
  durationSec?: number;
  rating?: number;
};

function HistoryCard({ entry, onPress }: { entry: TranscriptEntry; onPress: () => void }) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const persona = personas.find((p) => p.id === entry.personaId);
  const personaName = persona?.name ?? "Unknown persona";
  const rating = entry.rating ?? (entry.messages.length % 3) + 3; // 3-5
  const durationMin = Math.max(
    1,
    Math.round(((entry.durationSec ?? entry.messages.length * 25) / 60) * 10) / 10
  );
  return (
    <Pressable style={styles.historyCard} onPress={onPress}>
      <View style={styles.historyTop}>
        <Text style={styles.historyName}>{personaName}</Text>
        <Text style={styles.historyRating}>{"⭐".repeat(Math.max(3, Math.min(5, rating)))}</Text>
      </View>
      <Text style={styles.historyMeta}>
        {durationMin} min · {new Date(entry.createdAt).toLocaleDateString()}
      </Text>
      <Text style={styles.historySub}>Tap to view transcript</Text>
    </Pressable>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    container: {
      flex: 1,
      paddingHorizontal: 12,
      paddingVertical: 8,
      backgroundColor: colors.background
    },
    section: {
      backgroundColor: colors.background
    },
    topSection: {
      marginBottom: 4
    },
    historySection: {
      flex: 1
    },
    headerRow: {
      paddingHorizontal: 8,
      paddingTop: 8
    },
    title: {
      color: colors.textMain,
      fontSize: 22,
      fontWeight: "700",
      marginTop: 4
    },
    sectionLabel: {
      color: colors.textMain,
      fontSize: 22,
      fontWeight: "700"
    },
    sectionHeader: {
      paddingHorizontal: 12,
      marginTop: 8
    },
    sectionSubtitle: {
      color: colors.textMuted,
      marginTop: 4,
      fontWeight: "600"
    },
    rowHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 12,
      marginTop: 8
    },
    rowLink: { flexDirection: "row", alignItems: "center", gap: 4 },
    rowLinkText: { color: colors.textMain, fontWeight: "700" },
    minutesRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginHorizontal: 4,
      marginTop: 12
    },
    minutesLabel: {
      color: colors.textMuted,
      fontSize: 14
    },
    minutesValue: {
      color: colors.textMain,
      fontSize: 18,
      fontWeight: "700"
    },
    callButton: {
      marginTop: 12,
      backgroundColor: colors.primary,
      paddingVertical: 16,
      borderRadius: 12,
      alignItems: "center",
      shadowColor: "#000",
      shadowOpacity: 0.15,
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 8,
      elevation: 3
    },
    callButtonDisabled: { opacity: 0.35 },
    callText: {
      color: colors.primaryText,
      fontWeight: "800",
      fontSize: 18
    },
    empty: {
      color: colors.textMuted,
      textAlign: "center",
      marginTop: 12
    },
    historyCard: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      padding: 14,
      gap: 4
    },
    historyTop: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center"
    },
    historyName: {
      color: colors.textMain,
      fontWeight: "800",
      fontSize: 16
    },
    historyRating: {
      color: colors.primary,
      fontSize: 14
    },
    historyMeta: {
      color: colors.textMuted,
      fontSize: 13
    },
    historySub: {
      color: colors.textMain,
      fontWeight: "600",
      marginTop: 2
    }
  });

