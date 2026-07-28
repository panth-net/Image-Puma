import type { MetadataMode, NamingSettings } from './types';

const AI_SOURCE_TERM_PATTERNS: RegExp[] = [
  /(^|[ _.-])ai(?=$|[ _.-])/ig,
  /(^|[ _.-])ai[ _.-]?generated(?=$|[ _.-])/ig,
  /(^|[ _.-])generated(?=$|[ _.-])/ig,
  /(^|[ _.-])chatgpt(?=$|[ _.-])/ig,
  /(^|[ _.-])openai(?=$|[ _.-])/ig,
  /(^|[ _.-])claude(?=$|[ _.-])/ig,
  /(^|[ _.-])gemini(?=$|[ _.-])/ig,
  /(^|[ _.-])seedream(?=$|[ _.-])/ig,
  /(^|[ _.-])midjourney(?=$|[ _.-])/ig,
  /(^|[ _.-])dall[ _.-]?e(?=$|[ _.-])/ig,
  /(^|[ _.-])stable[ _.-]?diffusion(?=$|[ _.-])/ig,
  /(^|[ _.-])sdxl(?=$|[ _.-])/ig,
  /(^|[ _.-])leonardo(?=$|[ _.-])/ig,
  /(^|[ _.-])firefly(?=$|[ _.-])/ig,
  /(^|[ _.-])imagen(?=$|[ _.-])/ig,
  /(^|[ _.-])flux(?=$|[ _.-])/ig,
  /(^|[ _.-])ideogram(?=$|[ _.-])/ig,
  /(^|[ _.-])recraft(?=$|[ _.-])/ig,
  /(^|[ _.-])runway(?=$|[ _.-])/ig,
  /(^|[ _.-])synthid(?=$|[ _.-])/ig,
  /(^|[ _.-])mj[._-]?run(?=$|[ _.-])/ig,
];

export function shouldStripAiSourceTerms(
  metadataMode: MetadataMode | undefined,
  naming: Pick<NamingSettings, 'sanitizeAiTerms'>,
): boolean {
  return metadataMode === 'strip-all' || naming.sanitizeAiTerms !== false;
}

export function sanitizeFileSegment(value: string): string {
  const withoutForbiddenPunctuation = value.replace(/[<>:"/\\|?*]/g, '-');
  const withoutControlChars = Array.from(withoutForbiddenPunctuation)
    .map((char) => (char.charCodeAt(0) < 32 ? '-' : char))
    .join('');
  return withoutControlChars.trim();
}

export function stripAiSourceTerms(value: string): string {
  let stripped = value;
  for (const pattern of AI_SOURCE_TERM_PATTERNS) {
    stripped = stripped.replace(pattern, '$1');
  }

  return stripped
    .replace(/([ _.-])\1+/g, '$1')
    .replace(/^[ _.-]+|[ _.-]+$/g, '')
    .trim();
}
