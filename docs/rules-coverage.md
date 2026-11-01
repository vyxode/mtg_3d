# Cobertura de reglas

Referencia: Comprehensive Rules del 19 de junio de 2026. Cada regla marcada como hecha tiene al menos un test.

## Hecho (D1)

| Regla | Qué | Test |
| --- | --- | --- |
| 103.1, 103.5, 103.8a | Sorteo de quién elige, mulligan de Londres, el primer jugador no roba | `rules.test.ts` · game setup |
| 104.3a | Conceder en cualquier momento | game setup |
| 117.3b, 117.3c, 117.4, 117.5 | Prioridad: tras resolver al activo; quien actúa la recupera; pases seguidos; SBA antes de cada prioridad | priority and the stack |
| 305.1, 305.2 | Jugar tierra: una por turno, fase principal propia, pila vacía | casting restrictions |
| 302.6 | Mareo de invocación: ni {T} ni atacar | casting restrictions |
| 307 / 304 | Conjuros a velocidad de conjuro, instantáneos en cualquier prioridad | casting restrictions |
| 400.7 | Un objeto que cambia de zona es un objeto nuevo (id nuevo) | todos |
| 500.4 | La reserva de maná se vacía al terminar cada paso | casting restrictions |
| 502.4 | Sin prioridad en el paso de enderezar | random games |
| 508.8 | Sin atacantes se saltan bloqueadores y daño | casting restrictions |
| 509.1h, 510.1, 510.1c | Bloqueos; daño simultáneo; reparto libre entre varios bloqueadores (sin orden de daño desde Foundations) | combat |
| 514.1–514.3a | Limpieza: descartar a 7, quitar daño, fin de efectos "hasta el final del turno", SBA → prioridad y otra limpieza | damage and SBA |
| 601.2 (atómico) | Lanzar: objetivos, maná, pago; si algo es ilegal no ocurre nada | casting restrictions |
| 608.2b | Hechizo con todos los objetivos ilegales no se resuelve; objetivos ilegales no se ven afectados | priority and the stack |
| 613 capa 7c | Modificaciones de F/R "hasta el final del turno" | damage and SBA |
| 701.6 | Contrarrestar | priority and the stack |
| 704.5a, 704.5b, 704.5f, 704.5g | Vida ≤ 0, robar sin biblioteca, resistencia ≤ 0, daño letal | damage and SBA |
| Determinismo | Misma semilla + mismas entradas = misma partida | random games |

## Hecho (D2a) — `keywords-triggers.test.ts`

| Regla | Qué |
| --- | --- |
| 702.9b, 702.17b | Volar: solo lo bloquean criaturas con volar o alcance |
| 702.20b | Vigilancia: atacar no la gira |
| 702.10 | Prisa: ataca y usa {T} con mareo de invocación |
| 702.3b | Defensor: no puede atacar |
| 702.110b | Amenaza: dos o más bloqueadores |
| 702.7, 702.4, 510.4 | Primer golpe y dañar dos veces: segundo paso de daño de combate |
| 702.2, 704.5h | Toque mortal: cualquier daño es letal |
| 702.19b, 702.19e | Arrollar: daño letal a los bloqueadores antes del jugador; sin bloqueadores, todo al jugador |
| 702.15b | Vínculo vital: gana vidas a la vez que el daño |
| 702.12b | Indestructible: ignora el daño letal |
| 603.2, 603.3b, 603.3d | Disparadas al entrar y al morir; en la pila antes de la prioridad; APNAP; orden propio; objetivos, retiradas si no hay ninguno |
| 603.10a | Las disparadas al morir miran atrás (controlador anterior) |
| 608.2b | Una habilidad con todos sus objetivos ilegales no se resuelve |
| 115.1 | Contrarrestar hechizo no puede apuntar a habilidades |

## Hecho (D2b) — `d2b.test.ts`, `planeswalkers.test.ts`

| Regla | Qué |
| --- | --- |
| 602 | Habilidades activadas con coste de girar y de maná, en la pila; {T} con mareo de invocación prohibido |
| 604, 613 (7c) | Estáticas "tus criaturas obtienen +1/+1", con y sin "otras" |
| 111, 704.5d | Fichas; dejan de existir fuera del campo de batalla |
| 122 | Contadores +1/+1 |
| 701.8 | Destruir; indestructible lo impide |
| 603.2 | Disparadas "siempre que ganes vidas" |
| 106, 605 | Tierras de dos colores; el pago elige el color de cada fuente |
| 614.12 | Tierras de choque: pagar 2 vidas o entrar giradas |
| 704.5j | Regla de leyendas, con elección del jugador |
| 306.5b, 606.3 | Planeswalkers: lealtad inicial, habilidades de lealtad a velocidad de conjuro una vez por turno |
| 306.8, 704.5i | El daño quita lealtad; con 0 va al cementerio |
| 508.1b, 506.4c | Atacar a planeswalkers; si el planeswalker se va, el atacante no hace daño |
| 115.4 | "Cualquier objetivo" incluye planeswalkers |
| 701.17 | Moler |

## Atajos conocidos (comentados en el código con `shortcut:`)

- 601.2 se envía como una sola respuesta (objetivos + pago a la vez); se valida en el orden de la regla.
- El maná genérico se paga con incoloro y luego W, U, B, R, G; el jugador no elige qué maná sobra.
- Una fuente que ya dejó su zona no tiene palabras clave (sin último dato conocido de características).
- El daño letal para arrollar no cuenta el daño que otras criaturas asignan en el mismo paso.
- Solo existe la capa 7c.
- Si en una elección de objetivos solo hay una opción legal, el motor la elige solo.
- La regla de leyendas se aplica tras las demás acciones basadas en estado, no a la vez, porque necesita una elección.
- Solo existen contadores +1/+1 y de lealtad.

## Pendiente (D2b en adelante)

Disparadas al atacar, retardadas y de estado · protección y regeneración · capas 1–7d con dependencias · reemplazo y prevención generales · copias · cartas de varias caras · auras y equipos (704.5m) · costes adicionales y alternativos, X, modos · contadores -1/-1 y otros.
