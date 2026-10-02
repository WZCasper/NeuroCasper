export const DEFAULT_TEMPLATE = "{title}";

export interface TemplateVars {
  streamer: string;
  platform: string;
  title: string;
  game: string;
  link: string;
}

/** Replaces {key} placeholders in a template with values from `vars`. Unknown
 * placeholders are left untouched so a typo doesn't silently delete text. Not
 * tied to one template kind: the stream-notification text and the new-member
 * welcome text (src/lib/moderation-settings.ts) both use it. */
export function renderPlaceholders(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : undefined;
    return value ?? match;
  });
}

export function renderTemplate(template: string, vars: TemplateVars): string {
  return renderPlaceholders(template, { ...vars });
}
