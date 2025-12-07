import { useCallback, useMemo, useState } from "react";
import { FlatList, StyleSheet, View, Text, Modal, Pressable, ScrollView } from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { personas } from "../src/constants/personas";
import { PersonaCard } from "../src/components/PersonaCard";
import { useTheme } from "../src/context/ThemeContext";
import { useSessionStore } from "../src/state/useSessionStore";

export default function PersonasScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { setPersona, favorites, toggleFavorite } = useSessionStore();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [detailPersonaId, setDetailPersonaId] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      // Clear selection when entering this screen.
      setPersona(null);
      return undefined;
    }, [setPersona])
  );

  const detailPersona = personas.find((p) => p.id === detailPersonaId) ?? null;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>All Personas</Text>
        <Text style={styles.subtitle}>Tap to select · Star to favorite</Text>
      </View>
      <FlatList
        data={personas}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={{ marginBottom: 12 }}>
            <PersonaCard
              persona={item}
              selected={false}
              onSelect={(id) => {
                setDetailPersonaId(id);
              }}
              favorite={favorites.includes(item.id)}
              onToggleFavorite={toggleFavorite}
              fullWidth
            />
          </View>
        )}
        contentContainerStyle={{ paddingBottom: 16 }}
        showsVerticalScrollIndicator={false}
      />
      <Modal
        transparent
        visible={!!detailPersona}
        animationType="fade"
        onRequestClose={() => setDetailPersonaId(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            {detailPersona ? (
              <>
                <Text style={styles.modalTitle}>{detailPersona.name}</Text>
                <Text style={styles.modalMeta}>
                  {detailPersona.role} · Difficulty: {detailPersona.difficulty.toUpperCase()} · Voice:{" "}
                  {detailPersona.voice}
                </Text>
                <ScrollView style={{ maxHeight: 220, marginTop: 10 }}>
                  <Text style={styles.modalBody}>{detailPersona.prompt}</Text>
                </ScrollView>
                <View style={styles.modalActions}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Close persona details"
                    style={[styles.actionButton, styles.secondaryButton]}
                    onPress={() => setDetailPersonaId(null)}
                  >
                    <Text style={styles.secondaryText}>Close</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Select persona"
                    style={[styles.actionButton, styles.primaryButton]}
                    onPress={() => {
                      setPersona(detailPersona.id);
                      setDetailPersonaId(null);
                      router.back();
                    }}
                  >
                    <Text style={styles.primaryText}>Select persona</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    container: { flex: 1, padding: 16, backgroundColor: colors.background },
    header: { marginBottom: 12 },
    title: { color: colors.textMain, fontSize: 22, fontWeight: "800" },
    subtitle: { color: colors.textMuted, marginTop: 4 },
    modalBackdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.4)",
      justifyContent: "center",
      padding: 16
    },
    modalCard: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.border,
      shadowColor: "#000",
      shadowOpacity: 0.2,
      shadowOffset: { width: 0, height: 6 },
      shadowRadius: 12,
      elevation: 6
    },
    modalTitle: { color: colors.textMain, fontSize: 20, fontWeight: "800" },
    modalMeta: { color: colors.textMuted, marginTop: 6 },
    modalBody: { color: colors.textMain, marginTop: 10, lineHeight: 20 },
    modalActions: { flexDirection: "row", marginTop: 16, gap: 10 },
    actionButton: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 12,
      alignItems: "center",
      borderWidth: 1
    },
    secondaryButton: {
      backgroundColor: colors.surface,
      borderColor: colors.border
    },
    secondaryText: { color: colors.textMain, fontWeight: "700" },
    primaryButton: {
      backgroundColor: colors.primary,
      borderColor: colors.primary
    },
    primaryText: { color: colors.primaryText, fontWeight: "700" }
  });


