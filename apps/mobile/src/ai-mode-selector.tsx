import { useEffect, useState } from "react";
import { Pressable, Text, View, StyleSheet } from "react-native";
import { aiModeLabels, type AiModeId, type AiModes } from "@citygo/contracts";
import { tokens } from "@citygo/design-tokens";

export function MobileAiModeSelector({
  modes,
  selected,
  disabled,
  onSelect,
}: {
  modes?: AiModes;
  selected: AiModeId;
  disabled: boolean;
  onSelect: (mode: AiModeId) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  if (!modes) return null;
  return (
    <View style={styles.group}>
      <Text nativeID="ai-mode-label">Режим ответа</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Режим ответа: ${aiModeLabels[selected]}`}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        style={[styles.control, disabled && styles.disabled]}
        onPress={() => setOpen((value) => !value)}
      >
        <Text>
          {aiModeLabels[selected]} {open ? "▴" : "▾"}
        </Text>
      </Pressable>
      {open && (
        <View accessibilityRole="radiogroup" accessibilityLabel="Режим ответа">
          {modes.options.map((option) => (
            <Pressable
              key={option.id}
              accessibilityRole="radio"
              accessibilityLabel={option.label}
              accessibilityState={{
                checked: selected === option.id,
                disabled: disabled || !option.available,
              }}
              disabled={disabled || !option.available}
              style={[styles.control, !option.available && styles.disabled]}
              onPress={() => {
                onSelect(option.id);
                setOpen(false);
              }}
            >
              <Text>
                {option.label}
                {!option.available ? " — временно недоступен" : ""}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  group: { gap: tokens.space.sm, marginVertical: tokens.space.sm },
  control: {
    minHeight: 48,
    borderRadius: tokens.radius.control,
    borderWidth: 1,
    borderColor: tokens.color.border,
    paddingHorizontal: tokens.space.md,
    justifyContent: "center",
    backgroundColor: tokens.color.surface,
  },
  disabled: { opacity: 0.55 },
});
