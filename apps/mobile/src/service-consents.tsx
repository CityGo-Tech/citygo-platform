import { useState } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { tokens } from "@citygo/design-tokens";
import type { ServiceConsentForm } from "./service-consent-state";

export function MobileServiceConsents({
  form,
  disabled,
  onChange,
}: {
  form: ServiceConsentForm;
  disabled: boolean;
  onChange: (purpose: "personalData" | "marketing", granted: boolean) => void;
}) {
  const [expanded, setExpanded] = useState<"personalData" | "marketing" | null>(
    null,
  );
  return (
    <View style={styles.content}>
      {(["personalData", "marketing"] as const).map((purpose) => {
        const document = form.policy[purpose];
        const optional = purpose === "marketing";
        return (
          <View key={purpose} style={styles.content}>
            <View style={styles.row}>
              <Switch
                accessibilityLabel={document.label}
                value={form[purpose]}
                disabled={disabled}
                onValueChange={(granted) => onChange(purpose, granted)}
              />
              <Text style={styles.label}>
                {document.label}. {optional ? "Необязательно." : "Обязательно."}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: expanded === purpose }}
              onPress={() => setExpanded(expanded === purpose ? null : purpose)}
              style={styles.termsButton}
            >
              <Text style={styles.link}>
                {expanded === purpose ? "Скрыть" : "Прочитать"}{" "}
                {optional
                  ? "согласие на рекламную рассылку"
                  : "согласие на обработку персональных данных"}
              </Text>
            </Pressable>
            {expanded === purpose && (
              <View style={styles.terms}>
                <Text selectable>{document.text}</Text>
                <Text style={styles.version}>
                  Версия: {form.policy.version}
                </Text>
              </View>
            )}
          </View>
        );
      })}
      <Text style={styles.version}>
        Рекламная рассылка не влияет на доступ к CityGo.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 10 },
  row: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  label: { flex: 1, color: tokens.color.foreground, lineHeight: 22 },
  termsButton: { paddingVertical: 8 },
  link: { color: tokens.color.primaryStrong, textDecorationLine: "underline" },
  terms: { padding: 12, backgroundColor: tokens.color.background, gap: 10 },
  version: { color: tokens.color.muted, fontSize: 13 },
});
