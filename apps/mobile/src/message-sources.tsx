import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Message } from "@citygo/contracts";
import type { SessionTicket } from "@citygo/api-client";
import { tokens } from "@citygo/design-tokens";
import {
  mobileMessageSources,
  openMobileMessageSource,
} from "./message-sources-state";

export function MobileMessageSources({
  message,
  ticket,
  open,
  onOpenError,
}: {
  message: Message;
  ticket: SessionTicket;
  open: (url: string) => Promise<unknown>;
  onOpenError: (message: string) => void;
}) {
  const sources = ticket.active() ? mobileMessageSources(message) : [];
  if (!sources.length) return null;
  return (
    <View style={styles.group}>
      <Text style={styles.heading}>Источники</Text>
      {sources.map((source, index) => (
        <Pressable
          key={index + ":" + source.url}
          accessibilityRole="link"
          accessibilityLabel={`${source.title}, ${new URL(source.url).host}`}
          onPress={() => {
            void openMobileMessageSource(message, index, ticket, open).catch(
              () => {
                if (ticket.active())
                  onOpenError(
                    "Не удалось открыть источник. Повторите попытку.",
                  );
              },
            );
          }}
          style={styles.link}
        >
          <Text style={styles.title}>{source.title}</Text>
          <Text style={styles.host}>{new URL(source.url).host}</Text>
        </Pressable>
      ))}
    </View>
  );
}
const styles = StyleSheet.create({
  group: { gap: 8, marginTop: 12 },
  heading: { fontWeight: "700" },
  link: {
    minHeight: 48,
    padding: 12,
    borderWidth: 1,
    borderColor: tokens.color.border,
    borderRadius: 12,
    gap: 4,
  },
  title: { color: tokens.color.primaryStrong, textDecorationLine: "underline" },
  host: { color: tokens.color.muted, fontSize: 13 },
});
