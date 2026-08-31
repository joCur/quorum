import { stackEnv } from "./env.js";

/**
 * Reading the development mail relay.
 *
 * The verification mail is not a detail of the registration flow, it is the middle of it: without
 * opening the message and following the link, the account never becomes one that can sign in. So
 * the suite reads the real message out of the real relay rather than reaching into Keycloak to
 * mark the address verified — a shortcut that would leave the one step most likely to be broken
 * by a configuration change untested.
 */

interface MessageSummary {
  readonly ID: string;
  readonly To: readonly { readonly Address: string }[];
  readonly Subject: string;
}

/** Empties the inbox, so a spec only ever sees the messages it caused. */
export async function clearInbox(): Promise<void> {
  const response = await fetch(`${stackEnv.mailpitUrl}/api/v1/messages`, { method: "DELETE" });
  if (!response.ok) {
    throw new Error(`could not clear the mail inbox: ${String(response.status)}`);
  }
}

/** Waits for a message to the given address and returns its body as text. */
export async function waitForMessage(
  address: string,
  timeoutMs = 30_000,
): Promise<{ subject: string; body: string }> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const listed = await fetch(`${stackEnv.mailpitUrl}/api/v1/messages`);
    if (listed.ok) {
      const { messages } = (await listed.json()) as { messages: MessageSummary[] };
      const found = messages.find((message) =>
        message.To.some((recipient) => recipient.Address === address),
      );
      if (found) {
        const detail = await fetch(`${stackEnv.mailpitUrl}/api/v1/message/${found.ID}`);
        const body = (await detail.json()) as { Text?: string; HTML?: string };
        return { subject: found.Subject, body: body.Text ?? body.HTML ?? "" };
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`no mail arrived for ${address} within ${String(timeoutMs)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The first Keycloak action-token link in a message — what the recipient would click. */
export function actionLink(body: string): string {
  const match = /https?:\/\/[^\s"<>]*login-actions\/action-token[^\s"<>]*/.exec(body);
  if (match === null) throw new Error("the message carries no action link");
  // Mail bodies are HTML-escaped; the link has to be the one a mail client would open.
  return match[0].replaceAll("&amp;", "&").replaceAll("&#61;", "=").replaceAll("&#38;", "&");
}
