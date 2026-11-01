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

## Atajos conocidos (comentados en el código con `shortcut:`)

- 601.2 se envía como una sola respuesta (objetivos + pago a la vez); se valida en el orden de la regla.
- El maná genérico se paga con incoloro y luego W, U, B, R, G; el jugador no elige qué maná sobra.
- Sin último dato conocido todavía (llega con las disparadas en D2).
- Sin vigilancia: todos los atacantes se giran (palabras clave en D2).
- Solo existe la capa 7c.

## Pendiente (D2)

Habilidades disparadas, retardadas y de estado · palabras clave de combate (primer golpe, dañar dos veces, toque mortal, arrollar, volar, alcance, vigilancia, amenaza, vínculo vital, indestructible, protección) · capas 1–7d con dependencias · reemplazo y prevención · copias · cartas de varias caras · planeswalkers · regla de leyendas (704.5j) · auras (704.5m) · costes adicionales y alternativos, X, modos.
