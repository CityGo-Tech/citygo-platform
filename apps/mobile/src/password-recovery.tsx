import { useEffect, useMemo, useState } from "react";
import {
  Image,
  Pressable,
  Text,
  TextInput,
  View,
  StyleSheet,
  type TextInputProps,
} from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { createClient, createSessionGuard } from "@citygo/api-client";
import { tokens } from "@citygo/design-tokens";
import logo from "../../web/public/figma/citygo-original-logo.png";
import {
  createPasswordRecoveryLifetime,
  pendingPasswordRecovery,
  recoveryClock,
  recoveryCodeValid,
  recoveryNotice,
  recoveryPasswordError,
  type PendingPasswordRecovery,
} from "./password-recovery-state";

// Supplemental Figma auth primitives: the existing native controls have no
// secondary/label-layout props, so cannot express the 48px button/12px field.
function Action({
  title,
  secondary,
  disabled,
  onPress,
}: {
  title: string;
  secondary?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.action,
        secondary && styles.secondary,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.actionText, secondary && styles.secondaryText]}>
        {title}
      </Text>
    </Pressable>
  );
}
function RecoveryField({
  label,
  ...props
}: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        {...props}
        style={styles.input}
        placeholderTextColor={tokens.color.muted}
      />
    </View>
  );
}
export function MobilePasswordRecovery({
  base,
  sessionSignal,
  disabled,
  onBack,
  onRecovered,
}: {
  base: string;
  sessionSignal: AbortSignal;
  disabled: boolean;
  onBack: () => void;
  onRecovered: () => Promise<void>;
}) {
  const scope = useMemo(
    () => createPasswordRecoveryLifetime(sessionSignal, createSessionGuard),
    [sessionSignal],
  );
  const [policy, setPolicy] = useState<"loading" | "available" | "unavailable">(
    "loading",
  );
  const [email, setEmail] = useState(""),
    [pending, setPending] = useState<PendingPasswordRecovery | null>(null);
  const [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [repeated, setRepeated] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  const [now, setNow] = useState(Date.now);
  const clock = pending ? recoveryClock(pending, now) : null;
  function clearSecrets() {
    setPending(null);
    setCode("");
    setPassword("");
    setRepeated("");
  }
  useEffect(() => {
    const ticket = scope.begin();
    if (ticket)
      void createClient(base, {
        native: true,
        fetch: expoFetch,
        signal: () => ticket.signal,
      })
        .passwordRecoveryPolicy()
        .then((value) => {
          if (ticket.active()) setPolicy(value.passwordRecovery);
        })
        .catch(() => {
          if (ticket.active()) setPolicy("unavailable");
        })
        .finally(() => ticket.finish());
    const invalidate = () => {
      scope.reset();
      clearSecrets();
      setEmail("");
      setBusy(false);
      setError("");
      setStatus("");
    };
    sessionSignal.addEventListener("abort", invalidate);
    return () => {
      sessionSignal.removeEventListener("abort", invalidate);
      scope.dispose();
    };
  }, [scope, sessionSignal, base]);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending]);
  useEffect(() => {
    if (!clock?.expired) return;
    scope.reset();
    clearSecrets();
    setBusy(false);
    setStatus("");
    setError("Срок кода истёк. Начните восстановление заново.");
  }, [clock?.expired, scope]);
  async function submit(kind: "begin" | "resend" | "confirm") {
    if (disabled || busy || policy !== "available") return;
    if (
      kind !== "begin" &&
      (!pending || recoveryClock(pending, Date.now()).expired)
    )
      return;
    if (kind === "begin" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError("Укажите корректную электронную почту.");
      return;
    }
    if (
      kind === "resend" &&
      pending &&
      recoveryClock(pending, Date.now()).resendSeconds
    )
      return;
    if (kind === "confirm") {
      const invalid = recoveryPasswordError(password, repeated);
      if (invalid || !recoveryCodeValid(code)) {
        setError(invalid || "Введите 6 цифр из письма.");
        return;
      }
    }
    const ticket = scope.begin();
    if (!ticket) return;
    const current = pending,
      input = { email, code, password };
    setBusy(true);
    setError("");
    setStatus("");
    setCode("");
    setPassword("");
    setRepeated("");
    const api = createClient(base, {
      native: true,
      fetch: expoFetch,
      signal: () => ticket.signal,
    });
    try {
      if (kind === "confirm" && current) {
        await api.confirmPasswordRecovery(
          current.challengeId,
          current.proof,
          input.code,
          input.password,
        );
        ticket.check();
        clearSecrets();
        setEmail("");
        await onRecovered();
      } else {
        const value =
          kind === "resend" && current
            ? await api.resendPasswordRecovery(
                current.challengeId,
                current.proof,
              )
            : await api.beginPasswordRecovery(input.email);
        ticket.check();
        setNow(Date.now());
        setPending(pendingPasswordRecovery(value, Date.now()));
        setStatus(
          kind === "resend"
            ? "Если письмо может быть отправлено, новый код заменит предыдущий. Проверьте также папку «Спам»."
            : recoveryNotice,
        );
      }
    } catch (failure) {
      if (ticket.active()) {
        const status =
          failure && typeof failure === "object" && "status" in failure
            ? failure.status
            : null;
        if (status === 410) clearSecrets();
        setError(
          status === 429
            ? "Слишком много попыток. Подождите перед новым запросом."
            : kind === "confirm"
              ? "Не удалось завершить восстановление. Проверьте код или начните заново. Если пароль уже изменён, войдите с новым паролем."
              : "Не удалось выполнить запрос. Попробуйте позже; автоматической повторной отправки нет.",
        );
      }
    } finally {
      input.code = "";
      input.password = "";
      if (ticket.active()) setBusy(false);
      ticket.finish();
    }
  }
  function back() {
    scope.reset();
    clearSecrets();
    setEmail("");
    onBack();
  }
  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <View style={styles.brand} accessibilityLabel="СитиГо" accessible>
          <View style={styles.symbol}>
            <Image
              source={logo}
              style={styles.symbolImage}
              resizeMode="stretch"
              accessibilityIgnoresInvertColors
            />
          </View>
          <View style={styles.wordmark}>
            <Image
              source={logo}
              style={styles.wordmarkImage}
              resizeMode="stretch"
              accessibilityIgnoresInvertColors
            />
          </View>
        </View>
        <View style={styles.headerBack}>
          <Action title="← Назад" secondary onPress={back} />
        </View>
      </View>
      <View style={styles.content}>
        <Text style={styles.eyebrow}>CITYGO · ВАШ ПЕРЕЕЗД</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Восстановить доступ
        </Text>
        <Text style={styles.intro}>
          {pending
            ? "Введите код из письма и задайте новый пароль. После смены потребуется войти заново."
            : "Восстановление доступно для подтверждённой электронной почты аккаунта."}
        </Text>
        {!!error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {!pending ? (
          <RecoveryField
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoComplete="email"
            maxLength={254}
            editable={!busy && !disabled}
          />
        ) : (
          <>
            <RecoveryField
              label="Код из письма"
              value={code}
              onChangeText={setCode}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              maxLength={6}
              editable={!busy && !disabled}
            />
            <RecoveryField
              label="Новый пароль"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              textContentType="newPassword"
              maxLength={128}
              editable={!busy && !disabled}
            />
            <RecoveryField
              label="Повторите новый пароль"
              value={repeated}
              onChangeText={setRepeated}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="new-password"
              textContentType="newPassword"
              maxLength={128}
              editable={!busy && !disabled}
            />
            <Text style={styles.intro}>От 6 до 128 любых символов.</Text>
          </>
        )}
        <View style={styles.notice}>
          <Text style={styles.noticeTitle}>Проверьте почту</Text>
          <Text style={styles.body}>{recoveryNotice}</Text>
        </View>
        {policy === "unavailable" && (
          <Text accessibilityLiveRegion="polite" style={styles.intro}>
            Восстановление временно недоступно. Попробуйте позже.
          </Text>
        )}
        <Action
          title={
            busy
              ? "Подождите…"
              : pending
                ? "Сохранить новый пароль"
                : policy === "loading"
                  ? "Проверяем доступность…"
                  : "Отправить код"
          }
          disabled={
            disabled || busy || policy !== "available" || !!clock?.expired
          }
          onPress={() => void submit(pending ? "confirm" : "begin")}
        />
        {pending && (
          <Action
            title={
              clock?.resendSeconds
                ? `Отправить повторно через ${clock.resendSeconds} с`
                : "Отправить код повторно"
            }
            secondary
            disabled={
              disabled || busy || !!clock?.expired || !!clock?.resendSeconds
            }
            onPress={() => void submit("resend")}
          />
        )}
        {!!status && (
          <Text accessibilityLiveRegion="polite" style={styles.intro}>
            {status}
          </Text>
        )}
        <Action title="← Назад" secondary onPress={back} />
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  page: { backgroundColor: tokens.color.background },
  header: {
    height: 72,
    paddingHorizontal: tokens.space.md,
    paddingVertical: 12,
    backgroundColor: tokens.color.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.space.sm,
  },
  headerBack: { width: 116 },
  brand: {
    width: 192,
    height: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  symbol: { width: 52, height: 36.63, overflow: "hidden" },
  wordmark: { width: 128.65, height: 40, overflow: "hidden" },
  symbolImage: {
    position: "absolute",
    width: 52 * 2.1038,
    height: 36.63 * 2.9866,
    left: -52 * 0.5535,
    top: -36.63 * 0.7902,
  },
  wordmarkImage: {
    position: "absolute",
    width: 128.65 * 2.8109,
    height: 40 * 9.0405,
    left: -128.65 * 0.9044,
    top: -40 * 5.747,
  },
  content: { padding: tokens.space.md, gap: tokens.space.md },
  eyebrow: {
    color: tokens.color.primaryStrong,
    fontSize: 11,
    fontWeight: "700",
    lineHeight: 16,
  },
  title: {
    color: tokens.color.foreground,
    fontSize: 28,
    fontWeight: "700",
    lineHeight: 40.6,
  },
  intro: { color: tokens.color.muted, fontSize: 14, lineHeight: 20.3 },
  body: { color: tokens.color.foreground, fontSize: 14, lineHeight: 20.3 },
  error: { color: tokens.color.danger, fontSize: 14, lineHeight: 20.3 },
  field: {
    borderWidth: 1,
    borderColor: tokens.color.border,
    borderRadius: tokens.radius.control,
    padding: tokens.space.md,
    backgroundColor: tokens.color.surface,
    gap: tokens.space.sm,
  },
  label: {
    fontSize: 12,
    fontWeight: "700",
    color: tokens.color.foreground,
    lineHeight: 17.4,
  },
  input: {
    color: tokens.color.foreground,
    fontSize: 16,
    padding: 0,
    minHeight: 24,
    lineHeight: 23.2,
  },
  notice: {
    padding: tokens.space.md,
    gap: tokens.space.sm,
    borderRadius: tokens.radius.card,
    borderWidth: 1,
    borderColor: tokens.color.border,
    backgroundColor: "#F3F5FD",
  },
  noticeTitle: {
    fontSize: 14,
    lineHeight: 20.3,
    fontWeight: "700",
    color: tokens.color.foreground,
  },
  action: {
    minHeight: 48,
    borderRadius: tokens.radius.control,
    borderWidth: 1,
    borderColor: tokens.color.border,
    backgroundColor: tokens.color.primaryStrong,
    padding: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  actionText: {
    fontSize: 15,
    lineHeight: 21.75,
    fontWeight: "600",
    color: tokens.color.onAction,
    textAlign: "center",
  },
  secondary: { backgroundColor: tokens.color.surface },
  secondaryText: { color: tokens.color.foreground },
  disabled: { opacity: 0.5 },
});
