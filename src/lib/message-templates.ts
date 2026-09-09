export const DEFAULT_TEMPLATE = "{title}";

export interface TemplateVars {
  streamer: string;
  platform: string;
  title: string;
  game: string;
  link: string;
}

/** Replaces {key} placeholders in a template with values from `vars`. Unknown
 * placeholders are left untouched so a typo doesn't silently delete text. */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key)
      ? vars[key as keyof TemplateVars]
      : match;
  });
}
