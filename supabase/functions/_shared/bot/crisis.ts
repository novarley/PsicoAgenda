// Protocolo de crisis — detección DETERMINISTA por reglas.
//
// Decisión de diseño: no depende de un LLM. Un modelo puede caerse, agotar cuota
// gratuita o variar su respuesta; esta detección corre siempre, en cada mensaje,
// en cualquier paso del flujo, y antes que nada. Se prefiere el falso positivo
// (un humano revisa) al falso negativo. Las reglas las debe revisar el equipo clínico.

export type CrisisSeverity = 'high' | 'medium';

export interface CrisisMatch {
  severity: CrisisSeverity;
  rules: string[];
}

interface Rule { id: string; severity: CrisisSeverity; pattern: RegExp }

// Patrones sobre texto normalizado (minúsculas, sin tildes, letras repetidas colapsadas)
const RULES: Rule[] = [
  // Ideación / intención suicida
  { id: 'suicidio', severity: 'high', pattern: /\bsuicid/ },
  { id: 'quitarse_la_vida', severity: 'high', pattern: /\b(quitarme|quitar|acabar con|terminar con) (la|mi) vida\b/ },
  { id: 'matarse', severity: 'high', pattern: /\b(matarme|me voy a matar|me quiero matar|me mato)\b/ },
  { id: 'no_quiero_vivir', severity: 'high', pattern: /\b(no|ya no) (quiero|deseo|aguanto) (seguir )?(vivir|viviendo)\b/ },
  { id: 'quiero_morir', severity: 'high', pattern: /\bquiero (morir|morirme|desaparecer|dejar de existir)\b/ },
  { id: 'mejor_muerto', severity: 'high', pattern: /\b(mejor (estaria|estar) muert[oa]|no vale la pena vivir|sin (razon|razones|sentido) para vivir)\b/ },
  { id: 'acabar_con_todo', severity: 'high', pattern: /\bacabar con todo\b/ },
  // Métodos / autolesión
  { id: 'metodo', severity: 'high', pattern: /\b(tirarme|lanzarme|aventarme|ahorcarme|colgarme|envenenarme)\b/ },
  { id: 'metodo_verbo', severity: 'high', pattern: /\bme voy a (tirar|lanzar|aventar|ahorcar|colgar|envenenar|cortar)\b/ },
  { id: 'autolesion', severity: 'high', pattern: /\b(autolesion|autolesionarme|me autolesiono|hacerme dano|me hago dano|lastimarme|cortarme|me corto las venas|me corto)\b/ },
  { id: 'sobredosis', severity: 'high', pattern: /\b(sobredosis|tomarme (todas )?las pastillas|me tome (todas )?las pastillas)\b/ },
  // Riesgo por terceros
  { id: 'violencia', severity: 'high', pattern: /\b(me (esta|estan) (pegando|golpeando|amenazando)|me (quiere|quieren|va a|van a) matar|me violaron|abuso sexual)\b/ },
  // Crisis aguda de ansiedad / pánico
  { id: 'panico', severity: 'medium', pattern: /\b(ataque|crisis) de (panico|ansiedad|nervios)\b/ },
  { id: 'no_puedo_respirar', severity: 'medium', pattern: /\bno puedo respirar\b/ },
  { id: 'siento_que_muero', severity: 'medium', pattern: /\bsiento que me (muero|voy a morir|estoy muriendo)\b/ },
  { id: 'desmayo', severity: 'medium', pattern: /\bme (voy a|estoy) (desmayar|desmayando|ahogando)\b/ },
];

export function normalizeForMatching(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita tildes: "suicídarme" → "suicidarme"
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/([a-z])\1{2,}/g, '$1')                    // "quierooo" → "quiero"
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectCrisis(text: string): CrisisMatch | null {
  const normalized = normalizeForMatching(text);
  const hits = RULES.filter((r) => r.pattern.test(normalized));
  if (hits.length === 0) return null;
  return {
    severity: hits.some((h) => h.severity === 'high') ? 'high' : 'medium',
    rules: hits.map((h) => h.id),
  };
}

export interface CrisisLine { name: string; phone: string }

// Respaldo si la organización no configuró sus líneas. VERIFICAR con la autoridad
// sanitaria local antes de producción; cada sede debe tener sus líneas en BD.
const DEFAULT_LINES: Record<string, CrisisLine[]> = {
  CO: [
    { name: 'Emergencias', phone: '123' },
    { name: 'Línea de salud mental (Minsalud, opción 4)', phone: '192' },
  ],
  ES: [
    { name: 'Línea de atención a la conducta suicida', phone: '024' },
    { name: 'Emergencias', phone: '112' },
  ],
};

export function crisisLinesFor(countryCode: string, configured: CrisisLine[]): CrisisLine[] {
  if (configured.length > 0) return configured;
  return DEFAULT_LINES[countryCode] ?? [{ name: 'Número local de emergencias', phone: '112' }];
}

export function crisisReply(severity: CrisisSeverity, lines: CrisisLine[]): string {
  const list = lines.map((l) => `• ${l.name}: ${l.phone}`).join('\n');
  if (severity === 'high') {
    return [
      'Gracias por contármelo. Lo que sientes importa y no tienes que pasar por esto sin compañía.',
      '',
      'Si estás en peligro ahora mismo, llama de inmediato:',
      list,
      '',
      'Ya avisé a una persona de nuestro equipo clínico para que te contacte lo antes posible. ' +
        'Mientras tanto, si puedes, busca a alguien de confianza que esté contigo.',
    ].join('\n');
  }
  return [
    'Estoy aquí contigo. Intenta respirar despacio: toma aire en 4 segundos, sostenlo 4 y suéltalo en 6. Repite unas veces.',
    '',
    'Ya avisé a una persona de nuestro equipo para que te contacte. Si sientes que empeora o hay riesgo, llama:',
    list,
  ].join('\n');
}
