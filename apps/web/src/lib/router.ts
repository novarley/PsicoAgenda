// Enrutado mínimo por hash (#/pacientes/123): funciona en cualquier hosting estático
// sin reglas de reescritura y conserva la pantalla al recargar.
import { useEffect, useState } from 'react';

function segments(): string[] {
  return window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(segments);
  useEffect(() => {
    const onChange = () => setRoute(segments());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function go(path: string): void {
  window.location.hash = path.startsWith('/') ? path : `/${path}`;
}
