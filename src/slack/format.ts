/**
 * Strip Markdown to readable plain text.
 *
 * Slack renders `blocks` when they are present, so the message body needs no
 * plain tier of its own — but push notifications and screen readers see only
 * `text`, and neither renders Markdown. Sending the Markdown source there
 * shows literal `**asterisks**` to exactly the people least able to ignore
 * them.
 *
 * Deliberately one-directional: removing markers can only ever produce
 * plainer text, whereas translating them (Markdown to Slack's mrkdwn, say) is
 * lossy and ordering-dependent — converting `**bold**` to `*bold*` leaves it
 * matching the italic rule on the next pass. Nothing here can render
 * *wrongly*, only plainly, which is the right property for a fallback.
 */
export function toPlainText(markdown: string): string {
  let text = markdown;
  // Fenced code keeps its body and loses its fence.
  text = text.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, "$1");
  text = text.replace(/`([^`\n]+)`/g, "$1");
  // A link becomes its label; a bare autolink keeps its URL.
  text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
    label ? label : url
  );
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(?<![*_\w])[*_]([^*_\n]+)[*_](?![*_\w])/g, "$1");
  text = text.replace(/~~(.*?)~~/g, "$1");
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "• ");
  return text.trim();
}

export interface SlackMessageBody {
  /** Plain-text fallback for push notifications and screen readers. */
  text: string;
  /** Block Kit body Slack renders in place of `text`. */
  blocks: Array<{ type: "markdown"; text: string }>;
}

/**
 * A Slack message body from Markdown: the Markdown as a Block Kit markdown
 * block, plus a plain-text fallback (caller-supplied, else derived).
 */
export function slackMessageBody(
  markdown: string,
  options: { plainText?: string } = {}
): SlackMessageBody {
  return {
    text: options.plainText?.trim() || toPlainText(markdown),
    blocks: [{ type: "markdown", text: markdown }],
  };
}
