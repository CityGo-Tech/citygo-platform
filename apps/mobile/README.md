# CityGo Mobile

Expo SDK 57 / React Native 0.86. Shared schemas, tokens, native controls and API
client. Includes email/password sessions in SecureStore, questionnaire, plan,
quests, streaming chat, saved history and completion.

Build shared packages first: pnpm build.
Set EXPO_PUBLIC_API_URL to the API address reachable from the device.
Alternatively copy root .env.mobile.example to root .env.mobile. The mobile
launcher allows only the named public URL and development-tool settings; it
disables Expo's automatic dotenv loading. Do not put secrets in apps/mobile/.env.
For an Android emulator use http://10.0.2.2:4000; a physical device needs the host's
LAN address and API_HOST=0.0.0.0. Use HTTPS outside local development.
Never put the OpenAI key into an EXPO_PUBLIC variable.

pnpm mobile:dev starts Metro. pnpm mobile:export verifies Android/iOS JS bundles,
not signed native binaries. A device/emulator smoke test and EAS project/store
accounts are required before distributing builds. No EAS project is created by
this change. SDK 57 provides streaming fetch globally on native.

Desktop Web remains apps/web; this Expo package is not a replacement Web target.
