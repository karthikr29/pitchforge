import { useMemo } from "react";
import { View, Text, StyleSheet, Pressable, Image } from "react-native";
import { Persona } from "../types";
import { useTheme } from "../context/ThemeContext";

type Props = {
  persona: Persona;
  onSelect?: (id: string) => void;
  selected?: boolean;
  favorite?: boolean;
  onToggleFavorite?: (id: string) => void;
  fullWidth?: boolean;
};

export function PersonaCard({ persona, onSelect, selected, favorite, onToggleFavorite, fullWidth }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Pressable
      onPress={() => onSelect?.(persona.id)}
      style={[
        styles.card,
        selected ? styles.cardSelected : undefined,
        fullWidth && styles.cardFull
      ]}
    >
      <View style={styles.headerRow}>
        {persona.avatar ? (
          <Image source={{ uri: persona.avatar }} style={styles.avatar} />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Text style={styles.avatarInitial}>{persona.name.slice(0, 1)}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
      <Text style={styles.name}>{persona.name}</Text>
      <Text style={styles.role}>{persona.role}</Text>
        </View>
        {onToggleFavorite ? (
          <Pressable
            hitSlop={8}
            onPress={() => onToggleFavorite?.(persona.id)}
            style={styles.favoriteBtn}
          >
            <Text style={[styles.favoriteText, favorite && styles.favoriteTextActive]}>
              {favorite ? "★" : "☆"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.meta}>
        Difficulty: {persona.difficulty.toUpperCase()} · Voice: {persona.voice}
      </Text>
      <Text style={styles.prompt} numberOfLines={3}>
        {persona.prompt}
      </Text>
      {selected ? <Text style={styles.selected}>Selected</Text> : null}
    </Pressable>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      padding: 16,
      borderRadius: 16,
      width: 260,
      marginHorizontal: 8,
      borderWidth: 1,
      borderColor: colors.border
    },
    cardFull: {
      width: "100%",
      marginHorizontal: 0
    },
    cardSelected: {
      borderWidth: 2,
      borderColor: colors.primary
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12
    },
    avatar: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: colors.border
    },
    avatarFallback: {
      justifyContent: "center",
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.border
    },
    avatarInitial: {
      color: colors.textMain,
      fontWeight: "800"
    },
    favoriteBtn: {
      paddingHorizontal: 6,
      paddingVertical: 4
    },
    favoriteText: {
      color: colors.textMuted,
      fontSize: 18
    },
    favoriteTextActive: {
      color: colors.primary
    },
    name: {
      color: colors.textMain,
      fontSize: 20,
      fontWeight: "700"
    },
    role: {
      color: colors.textMuted,
      marginTop: 4,
      fontWeight: "500"
    },
    meta: {
      color: colors.textMuted,
      marginTop: 6,
      fontSize: 12
    },
    prompt: {
      color: colors.textMain,
      marginTop: 8,
      fontSize: 14
    },
    selected: {
      marginTop: 10,
      color: colors.primary,
      fontWeight: "700"
    }
  });

