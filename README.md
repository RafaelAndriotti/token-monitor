# Token Monitor

Painel de consumo de tokens dos seus agentes de IA, com um personagem animado
por agente.

A medida é **token**, não dinheiro: num plano de assinatura o que acaba é a
cota, e o preço da API de primeira parte não diz nada sobre ela. O custo em
dólar continua sendo calculado e guardado, mas não aparece no painel.

Cada agente é um personagem com papel próprio: orquestrador, designer,
frontend, backend, devops, dados, QA, revisor e pesquisador. O papel decide a
cor, o acessório de cabeça e o que ele segura. Quando o agente chama o modelo, o
personagem dele pensa, trabalha e conclui — ao vivo, pelo stream.

```
agente ──POST /v1/activity──▶ estado em memória ──┐
       └─POST /v1/events────▶ SQLite ─────────────┼─▶ SSE /v1/stream ──▶ palco
                                 └──────────────▶ /v1/stats/* ────────▶ gráficos
```

## Conectar um projeto seu

```bash
npm run connect
```

Lista as pastas de transcript do Claude Code e diz quais já estão conectadas.
Para ligar uma:

```bash
npm run connect -- --nome din-din
```

Todo o histórico entra junto, e **nada muda no seu projeto** — sem hook, sem
chave, sem tocar no `.claude/settings.json` dele. Passo a passo e ajustes em
[CONECTAR.md](CONECTAR.md).

## Rodando

```bash
npm install
npm run dev
```

Abra <http://localhost:4000>. A API e o painel são servidos pela mesma porta.

Para encher o painel antes de integrar qualquer agente:

```bash
npm run seed
```

Para ver a animação sem ligar os agentes de verdade — um prompt passando pelo
time, com o orquestrador delegando e os três especialistas trabalhando em
paralelo:

```bash
npm run demo
```

```bash
node scripts/demo.js "refazer a tela de login"
```

Para deixar o palco em movimento contínuo, com o time inteiro e erros de vez em
quando:

```bash
npm run showroom
```

```bash
npm run showroom -- --once --fast
```

E para ver todos os papéis e todos os estados lado a lado, sem agente nenhum
rodando, abra <http://localhost:4000/showroom.html>.

Nem o demo nem o showroom contatam API externa: as "chamadas ao modelo" são
esperas com números de tokens plausíveis, então nenhum token é gasto na sua
conta.

Requer Node 22.5 ou superior — o banco usa o módulo `node:sqlite`, embutido no
Node, sem dependência nativa para compilar. Ele ainda é marcado como
experimental, daí o aviso no console ao subir o servidor.

## O palco

O orquestrador fica em cima, os especialistas embaixo, ligados por feixes que
acendem enquanto aquele agente trabalha. Cada personagem tem cinco estados:

| Estado | Quando | O que aparece |
| --- | --- | --- |
| `parado` | sem chamadas recentes | só respira e pisca |
| `pensando` | ping de início, antes da resposta | três pontos subindo, antena inclinando |
| `trabalhando` | evento de uso chegou | braço e acessório em movimento, faíscas de token |
| `concluido` | o ciclo acabou | um pulo e o selo de visto |
| `erro` | a chamada falhou | um tremor e o X |

Os estados vivem **só em memória**. Reiniciar o servidor devolve todo mundo
para `parado`; o histórico em tokens continua intacto no SQLite.

Sem receber nada novo, um agente volta sozinho para `parado` depois de
`ACTIVITY_TTL_MS` (30 s por padrão) — é o que evita um personagem preso
trabalhando porque o processo do agente morreu no meio.

### Papéis

O papel decide três coisas: a cor, o acessório de cabeça (fone no orquestrador,
boina na designer, boné no frontend, capacete no backend, lanterna no devops,
viseira em dados, faixa no QA, óculos no revisor, chapéu de aba larga no
pesquisador) e o que ele segura. Na primeira vez que um agente
manda evento, o papel é chutado pelo nome (`frontend-react` → frontend,
`orquestrador-v2` → orquestrador) e pode ser corrigido no painel, em **papéis e
cotas**, ou pela API:

```bash
curl -X PUT http://localhost:4000/v1/agents/meu-agente \
  -H 'content-type: application/json' \
  -d '{"role":"designer","displayName":"Dê"}'
```

Papéis disponíveis em `GET /v1/roles`. A identidade nunca é só a cor: cada
personagem tem rótulo e acessório próprios, e o painel continua legível com
`prefers-reduced-motion` ligado — a pose e o selo dizem o estado sem movimento.

## Instrumentando um agente

```js
import { createTracker } from './sdk/tracker.js';

const tracker = createTracker({ agent: 'backend' });

const response = await tracker.measure(
  () => client.messages.create({ model: 'claude-opus-5-5', max_tokens: 16000, messages }),
  { operation: 'endpoint' },
);
```

`measure` manda o ping de `pensando` **antes** da chamada, mede a latência, lê
o `usage` da resposta e, quando a chamada falha, registra o evento com
`status: 'error'` antes de repropagar o erro. É por isso que o personagem anima
durante a chamada, e não só depois dela.

Os dois canais se comportam de forma diferente de propósito: o uso vai numa
fila em memória e sai em lote, enquanto o sinal de atividade sai na hora e sem
esperar resposta. Painel fora do ar não derruba nem trava o agente.

### Costurando um prompt inteiro

Um `runId` liga todas as chamadas do mesmo prompt, e é o que o painel mostra na
linha do ciclo:

```js
const maestro = createTracker({ agent: 'orquestrador' });
await maestro.startRun({ label: 'refazer a tela de login' });

// Os outros agentes entram no mesmo ciclo pelo mesmo runId.
const front = createTracker({ agent: 'frontend', runId: maestro.runId });

await maestro.endRun();
```

Sem `runId` tudo continua funcionando: os personagens animam, só não há um
ciclo nomeado para agrupá-los.

Para registrar manualmente, sem o wrapper:

```js
tracker.begin({ operation: 'resumo' });
tracker.track({ model: response.model, usage: response.usage });
```

Exemplo completo em [`examples/anthropic-agent.js`](examples/anthropic-agent.js).

### Qualquer provedor, qualquer linguagem

Os dois endpoints aceitam JSON puro — não precisa do SDK:

```bash
curl -X POST http://localhost:4000/v1/activity \
  -H 'content-type: application/json' \
  -d '{"agent":"backend","state":"pensando","operation":"migracao"}'
```

```bash
curl -X POST http://localhost:4000/v1/events \
  -H 'content-type: application/json' \
  -d '{"agent":"backend","model":"gpt-x","inputTokens":1200,"outputTokens":300}'
```

Um lote com eventos de mais de 2 minutos atrás não acende o palco — é
histórico, não trabalho acontecendo agora.

## Endpoints

| Método | Rota | O que faz |
| --- | --- | --- |
| `GET` | `/health` | Status da API e do banco, uptime e total de eventos. Responde 503 se o banco falhar. |
| `POST` | `/v1/events` | Ingestão de uso. Aceita um objeto, um array ou `{ events: [...] }`, até 1000 por lote. |
| `POST` | `/v1/activity` | Sinal de estado: `pensando`, `trabalhando`, `concluido`, `erro`, `parado`. |
| `GET` | `/v1/activity` | Estado ao vivo de todos os agentes e os últimos ciclos. |
| `GET` | `/v1/stream` | SSE: `hello`, `activity`, `event`, `run`, `alert`, `roster`. |
| `GET` | `/v1/stage` | Tudo que o palco precisa numa chamada. `?period=day\|week\|month`. |
| `POST` | `/v1/runs` · `/v1/runs/:id/end` | Abre e fecha um ciclo (um prompt). |
| `GET` | `/v1/agents` · `PUT`/`DELETE` `/v1/agents/:nome` | Elenco e papéis. |
| `GET` | `/v1/roles` | Papéis disponíveis, com rótulo e acessório. |
| `GET` | `/v1/stats/summary` | Totais do período (tokens, chamadas, erros, latência média). |
| `GET` | `/v1/stats/timeseries` | Série temporal. `?bucket=minute\|hour\|day`. |
| `GET` | `/v1/stats/by/:dimensão` | Agregado por `agent`, `model`, `provider` ou `operation`. |
| `GET` | `/v1/events` | Chamadas recentes, com `limit` e `offset`. |
| `GET` | `/v1/meta` | Agentes, modelos e provedores existentes. |
| `GET` | `/v1/budgets` · `PUT`/`DELETE` `/v1/budgets/:agente` | Cotas de tokens. |
| `GET` | `/v1/alerts` | Só as cotas em atenção ou estouradas. |
| `GET` | `/v1/reports/weekly` · `/weekly.html` | Relatório da última semana fechada. |
| `POST` | `/v1/reports/weekly/send` | Envia o relatório agora. 409 se o e-mail não estiver configurado. |

Filtros aceitos nas rotas de consulta: `from`, `to` (datas ISO), `agent`,
`model`, `provider`.

## Configuração

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `PORT` | `4000` | Porta da API e do painel. |
| `DB_PATH` | `data/tokens.db` | Arquivo SQLite. |
| `API_KEY` | — | Quando definida, ingestão e atividade exigem o header `x-api-key`. |
| `TOKEN_MONITOR_URL` | `http://localhost:4000` | Usada pelo SDK, pelo seed e pelo demo. |
| `TOKEN_MONITOR_API_KEY` | — | Chave que o SDK envia. |
| `ACTIVITY_TTL_MS` | `30000` | Quanto um agente fica animado sem receber nada novo. |
| `ACTIVITY_DONE_MS` | `6000` | Quanto o selo de concluído fica na tela. |
| `ACTIVITY_ERROR_MS` | `12000` | Quanto o selo de erro fica na tela. |
| `ALERT_WEBHOOK_URL` | — | Destino dos alertas de cota. Sem ela, os alertas só aparecem no log e no painel. |
| `REPORT_TO` | — | Destinatários do relatório semanal, separados por vírgula. Vazio desliga o envio. |
| `REPORT_FROM` | `Token Monitor <token-monitor@localhost>` | Remetente. |
| `SMTP_URL` | — | Servidor SMTP numa URL só. Alternativa a `SMTP_HOST`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | porta `587` | Servidor SMTP em partes. |
| `REPORT_DAY` / `REPORT_HOUR` | `1` / `9` | Dia (0 = domingo) e hora UTC do envio. |
| `MAIL_DRY_RUN` | — | `1` monta a mensagem sem abrir conexão SMTP. |
| `IMPORT_INTERVAL_SEC` | `30` | De quanto em quanto tempo o servidor relê os transcripts. `0` desliga. |
| `CLAUDE_PROJECTS_DIR` | `~/.claude/projects` | Onde ficam os transcripts do Claude Code. |
| `PATH_MAP` | — | Traduz caminhos do Windows para o disco do container: `C:\dev=/host/dev;...`. Veja [CONECTAR.md](CONECTAR.md#rodar-no-docker). |

## Cotas de tokens

Você define um teto de tokens por agente e por período (dia, semana ou mês). O
agente `*` é a cota global: soma todos os agentes.

```bash
curl -X PUT http://localhost:4000/v1/budgets/backend \
  -H 'content-type: application/json' \
  -d '{"period":"month","limitTokens":4000000,"warnPct":0.8}'
```

Cada cota tem três estados: `ok`, `atencao` (a partir de `warnPct`, 80% por
padrão) e `estourado`. A cada ingestão a API reavalia só os agentes daquele
lote e dispara o alerta **quando o estado sobe** — chamadas seguintes no mesmo
nível não repetem a notificação, e o ciclo recomeça sozinho quando o período
vira.

Os alertas aparecem no topo do painel, chegam pelo stream, saem no log do
servidor e vão para `ALERT_WEBHOOK_URL`, se configurada. O corpo do POST traz
`text` (Slack), `content` (Discord) e `alert` com os dados completos, então o
mesmo webhook serve para os três casos. Webhook fora do ar não derruba a
ingestão: o erro é logado e a resposta do `POST /v1/events` sai normalmente, já
com os alertas no campo `alerts`.

Os períodos são calculados em UTC; a semana começa na segunda-feira.

## Relatório semanal por e-mail

Toda segunda às 9h UTC, o servidor envia o fechamento da semana anterior:
tokens no total com a variação contra a semana retrasada, consumo por agente,
uso por modelo e as cotas fora do lugar. Dia e hora saem de `REPORT_DAY` e
`REPORT_HOUR`.

Confira antes de ligar o envio:

```bash
npm run report
```

```bash
MAIL_DRY_RUN=1 REPORT_TO=voce@exemplo.com npm run report:send
```

A prévia do e-mail também abre no navegador, em `/v1/reports/weekly.html`.

Para valer, aponte para o seu SMTP e defina os destinatários:

```bash
SMTP_URL='smtps://usuario:senha@smtp.exemplo.com:465' REPORT_TO='voce@exemplo.com' npm start
```

O agendador calcula quanto falta para o próximo horário e dorme até lá, sem
dependência de cron. Como o timer vive no processo, um servidor que reinicia
entre segundas não reenvia o relatório: ele apenas reagenda para a segunda
seguinte. Se o processo ficar fora do ar justamente no horário do envio,
dispare na mão com `npm run report:send` ou `POST /v1/reports/weekly/send`.

A semana vai de segunda a domingo em UTC, o mesmo corte das cotas.

## Custo em dólar

[`server/src/pricing.js`](server/src/pricing.js) traz os preços por 1M de
tokens dos modelos Claude, nas tarifas da API de primeira parte da Anthropic.
O custo continua sendo calculado e gravado na coluna `cost_usd`, mas o painel,
as cotas e o relatório não usam mais esse número — num plano de assinatura ele
não corresponde ao que você paga. Ele está ali para o dia em que parte do
tráfego for por API; aí é só ler a coluna.

## Painel

HTML e JavaScript estáticos servidos pelo Express, em
[`server/public/`](server/public). React e htm vêm por CDN e tanto os
personagens quanto os gráficos são SVG escrito à mão, então não há etapa de
build nem `node_modules` no front.

Os personagens são isométricos: cada bloco tem três faces — a frente na cor do
papel, o topo mais claro, a lateral mais escura — e as três saem da mesma
variável `--role` por `color-mix`. Trocar o papel de um agente troca o
personagem inteiro, inclusive o acessório. Nenhuma imagem é carregada.

A tela fica quieta de propósito: a cor vive nos personagens e nas barras, os
KPIs são tipografia (sem ícone em círculo, sem sparkline), os cartões se
separam por uma linha de 1px e o cabeçalho não passa de 21px. É o que a skill
[Taste Skill](https://www.tasteskill.dev/) chama de deixar o produto ter cara
própria sem encher a tela de enfeite.

As animações são CSS puro, ligadas pelo atributo `data-state` no SVG: o React
muda o estado e sai do caminho, sem participar do loop de animação. Tempos e
curvas seguem as do [Taste Skill](https://www.tasteskill.dev/) — ease-out forte
para entradas, `ease` para cor, nada de bounce, só `transform` e `opacity`.

O estado ao vivo chega por SSE; os agregados são recarregados por HTTP com um
atraso curto, para uma rajada de eventos não refazer a conta a cada token.

## Antes de colocar em produção

- Defina `API_KEY`: sem ela a ingestão é aberta a quem alcançar a porta.
- O estado ao vivo é por processo. Com mais de uma instância atrás de um
  balanceador, cada uma teria o seu palco; nesse caso o `activity.js` precisa
  de um Redis no lugar do `Map`.
- SQLite aguenta bem um volume moderado de escrita; acima disso, troque
  [`server/src/db.js`](server/src/db.js) por Postgres mantendo o mesmo schema.
- Não há retenção: a tabela `events` cresce para sempre. Um job que apaga ou
  agrega eventos antigos resolve.
