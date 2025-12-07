import { useMemo } from "react";
import { View, StyleSheet } from "react-native";
import { useTheme } from "../context/ThemeContext";

type Props = {
  active?: boolean;
};

export function AudioWave({ active }: Props) {
  const { colors } = useTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const bars = Array.from({ length: 8 });
  return (
    <View style={styles.container}>
      {bars.map((_, idx) => (
        <View
          key={idx}
          style={[
            styles.bar,
            { height: active ? 10 + (idx % 3) * 8 : 6 }
          ]}
        />
      ))}
    </View>
  );
}

const createStyles = (colors: ReturnType<typeof useTheme>["colors"]) =>
  StyleSheet.create({
    container: {
      flexDirection: "row",
      alignItems: "flex-end",
      height: 40,
      gap: 4
    },
    bar: {
      width: 6,
      backgroundColor: colors.primary,
      borderRadius: 3
    }
  });

