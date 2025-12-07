import { useMemo } from "react";
import { FlatList, StyleSheet, View, Text } from "react-native";
import { useRouter } from "expo-router";
import { personas } from "../src/constants/personas";
import { PersonaCard } from "../src/components/PersonaCard";
import { useTheme } from "../src/context/ThemeContext";
import { useSessionStore } from "../src/state/useSessionStore";

export default function PersonasScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { personaId, setPersona, favorites, toggleFavorite } = useSessionStore();
  const styles = useMemo(() => createStyles(colors), [colors]);

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
              selected={item.id === personaId}
              onSelect={(id) => {
                setPersona(id);
                router.back();
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
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    container: { flex: 1, padding: 16, backgroundColor: colors.background },
    header: { marginBottom: 12 },
    title: { color: colors.textMain, fontSize: 22, fontWeight: "800" },
    subtitle: { color: colors.textMuted, marginTop: 4 }
  });


