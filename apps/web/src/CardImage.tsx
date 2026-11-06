import { useState, type ImgHTMLAttributes } from 'react';
import { displayName } from '@mtg3d/cards';
import { placeholderUrl } from './placeholder';

/**
 * A card's image by its (English) name; if it can't be loaded, a plain frame drawn from the card's own data
 * (name, cost, type, Spanish text), never a wrong picture.
 */
export function CardImage({ name, src, ...rest }: { name: string; src: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'>) {
  const [broken, setBroken] = useState(false);
  return <img {...rest} src={broken ? placeholderUrl(name) : src} alt={displayName(name)} onError={() => { setBroken(true); }} />;
}
