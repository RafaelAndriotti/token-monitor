# Conectar um projeto ao Token Monitor

Como fazer o painel mostrar os agentes de um projeto seu e o que eles gastaram.

**Você não precisa alterar nada no projeto.** Nenhum hook, nenhuma chave,
nenhuma linha a mais no `.claude/settings.json` de lá. O monitor lê os
transcripts que o Claude Code já grava sozinho em `~/.claude/projects`.

---

## Antes de começar

Três coisas:

1. **Node 22.5 ou superior.** `node --version` para conferir.
2. **O monitor instalado**, que é esta pasta. Se ainda não rodou:

```bash
npm install
```

3. **Ter usado o Claude Code no projeto pelo menos uma vez.** Sem sessão
   nenhuma não há transcript para ler, e o projeto nem aparece na lista.

O monitor precisa rodar **na mesma máquina** que o Claude Code — ele lê
arquivos do disco, não recebe nada pela rede.

---

## 1. Ver o que dá para conectar

```bash
npm run connect
```

Saída de exemplo:

```
pastas em C:\Users\rafael.rebelo\.claude\projects:

    9 sessões  C:\Users\rafael.rebelo\Desktop\Din-Din
              já conectado a "din-din"
    1 sessões  C:\Users\rafael.rebelo\Desktop\Controle financeiro
              livre
```

O caminho mostrado é o **real**, lido de dentro do transcript. O nome da pasta
em `~/.claude/projects` não serve para isso: `Desktop-Din-Din` tanto poderia
ser `Desktop\Din-Din` quanto `Desktop\Din\Din`.

---

## 2. Conectar

Casando por qualquer pedaço do caminho:

```bash
npm run connect -- --nome din-din
```

O `--` antes das opções é exigência do npm: sem ele as opções vão para o npm e
não para o script.

Saída:

```
conectando "Din-Din" (din-din)
  lendo C:\Users\rafael.rebelo\.claude\projects\c--Users-rafael-rebelo-Desktop-Din-Din
  469 eventos novos, 0 já conhecidos, em 0.2s
  painel: http://localhost:4000/?project=din-din
```

**Todo o histórico entra junto.** O painel não começa vazio: o que você já fez
no projeto antes de conectar está lá.

Para conectar tudo o que ainda está livre, de uma vez:

```bash
npm run connect -- --todos
```

---

## 3. Abrir o painel

```bash
npm start
```

Abra <http://localhost:4000>. O seletor de projeto fica no canto superior
direito, e aparece a partir do segundo projeto conectado.

O endereço carrega o projeto (`?project=din-din`), então dá para salvar o link
de cada um e voltar direto nele.

---

## O que aparece

Cada agente do projeto vira um personagem no palco. No Din-Din, por exemplo:

| agente | virou | de onde veio o nome |
| --- | --- | --- |
| `orquestrador` | Orquestrador | sessão principal |
| `designer` | Designer | subagente |
| `frontend-especialista` | Frontend | subagente |
| `mentor-backend` | Backend | subagente |
| `cacador-de-bugs` | QA | subagente |
| `Explore` | Pesquisador | subagente embutido do Claude Code |

Os subagentes vêm do `.claude/agents/` do seu projeto; o nome é o mesmo que
você deu a eles. O papel é chutado pelo nome e decide a cor, o acessório de
cabeça e o que o personagem segura.

---

## Ajustes

### O papel saiu errado

No painel, botão **papéis e cotas**, e troque no seletor da linha do agente. A
mudança vale na hora e fica guardada.

### O nome da sessão principal

A sessão principal entra como `orquestrador` por padrão. Se no seu projeto ela
for outra coisa:

```bash
npm run connect -- --nome meu-projeto --agente lider
```

Vale dizer isto **na hora de conectar**. Trocar depois só afeta o que entrar
daí para frente — os eventos já importados ficam com o nome antigo, e o
personagem velho continua no palco.

### O id do projeto

Sai do nome da pasta (`Din-Din` → `din-din`). Para escolher outro:

```bash
npm run connect -- --nome din-din --id financeiro
```

O id é **imutável** depois de criado: é ele que está gravado em cada evento.
Renomear o projeto no painel muda só o rótulo.

### Uma cota de tokens

No painel, **papéis e cotas**. O agente `*` é a cota do projeto inteiro.

Escolha a métrica com cuidado:

| métrica | o que conta |
| --- | --- |
| `faturavel` | entrada + escrita em cache + saída — **o padrão** |
| `total` | tudo, incluindo releitura de cache |
| `saida` | só o que o modelo escreveu |

No Din-Din real, **95% do `total` é cache relido**. Uma cota em cima de `total`
estoura no primeiro dia sem significar nada sobre o seu consumo.

---

## Manter atualizado

O servidor relê os transcripts **sozinho toda vez que sobe**. É isso que
recupera o que aconteceu enquanto ele estava desligado — nada se perde.

Para puxar agora, sem reiniciar:

```bash
npm run import
```

Reler é sempre seguro. Cada mensagem do transcript carrega um identificador
próprio, gravado sob índice único, então ela vira um evento só por mais vezes
que o arquivo passe pelo importador. Rodar o `connect` de novo no mesmo projeto
apenas reimporta o que faltava.

---

## Desconectar

```bash
curl -X DELETE "http://localhost:4000/v1/projects/din-din/sources?dir=<pasta>"
```

Isso só para de ler a pasta. Os eventos já importados continuam no banco e no
painel — apagá-los é decisão separada, direto no SQLite em `data/tokens.db`.

---

## Limites e privacidade

- **Mesma máquina.** O monitor lê arquivos locais. Para uma máquina remota
  seria preciso um agente que lesse lá e empurrasse para cá.
- **A pasta que ele lê é pessoal.** `~/.claude/projects` guarda o texto das
  suas conversas. O importador extrai só números de uso, mais o nome final da
  pasta e o branch do git. O **texto do seu prompt** só é guardado como rótulo
  do ciclo se você ligar `RUN_LABELS=1`; sem isso o ciclo se chama `prompt 3`.
  As rotas de leitura da API são abertas a quem alcançar a porta, então pense
  nisso antes de ligar.
- **Não misture com o SDK.** Se um projeto usar `sdk/tracker.js` *e* for lido
  do disco, o mesmo trabalho conta duas vezes: os eventos do SDK não têm
  identificador de origem e não colidem com os do transcript. Escolha um modo
  por projeto.
- **O formato não é documentado.** O layout do `.jsonl` do Claude Code pode
  mudar numa versão futura. O importador ignora linha que não entende em vez de
  quebrar, mas uma mudança grande exigiria ajuste.

---

## Quando não aparece

| sintoma | o que é |
| --- | --- |
| O projeto não está na lista do `connect` | Nenhuma sessão do Claude Code naquela pasta ainda. Use-o uma vez e rode de novo. |
| Conectou, mas o painel está vazio | Confira o seletor de projeto no topo — pode estar mostrando outro. O endereço diz qual: `?project=...` |
| `0 eventos novos` numa pasta com sessões | Já estava tudo importado. `npm run import` confirma. |
| Falta um subagente no palco | Subagentes internos do Claude Code vêm sem nome e são descartados de propósito. Os seus, do `.claude/agents/`, sempre têm. |
| `SQLITE_BUSY` | O servidor e o script escrevendo juntos. Já há espera configurada; se insistir, pare o servidor e rode de novo. |

Visão geral da API em [README.md](README.md).
