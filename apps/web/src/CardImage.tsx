import { useState, type ImgHTMLAttributes } from 'react';

/** A card image that falls back to a frame with the card's name if the image can't be loaded (never a wrong picture). */
export function CardImage({ name, src, className, ...rest }: { name: string; src: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'alt'>) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className={`card-fallback ${className ?? ''}`} role="img" aria-label={name}><span>{name}</span></span>;
  return <img {...rest} className={className} src={src} alt={name} onError={() => { setBroken(true); }} />;
}
