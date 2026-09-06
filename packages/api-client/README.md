# API client

createClient is consumed by Web, Expo and Admin. Browser sessions use HttpOnly
cookies; native clients supply an in-memory token retrieved from SecureStore.

The client streams SSE with a persistent UTF-8 decoder, supports cancellation,
and rejects an interrupted stream that lacks a done event. Mutations are not
silently retried. A chat request UUID lets the server reject duplicate submission.
