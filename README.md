# Elastic Logs Viewer

Visor de logs dos clientes: informa a URL do Kibana do cliente e filtra os logs dos containers (índice `dockers-*`).
A busca vai pelo `/api/console/proxy` do próprio Kibana, então basta a URL que abre no navegador — não precisa da 9200.

## Rodar

1. `cp .env.example .env` e preencha `KIBANA_USER` / `KIBANA_PASS`.
2. `npm start` (ou `node server.js`) — Node 20.12+, sem dependências.
3. Abra http://localhost:4600.

## Rodar em container (sempre no ar)

Na pasta com o `.env` preenchido:

```bash
docker build -t elastic-logs-viewer .
docker run -d --name elastic-logs-viewer --restart unless-stopped --env-file .env -e HOST=0.0.0.0 -p 4600:4600 elastic-logs-viewer
```

`--restart unless-stopped` religa o container quando a máquina/docker reinicia (o serviço docker precisa estar
habilitado no boot). Atualizar: `docker build` de novo, `docker rm -f elastic-logs-viewer` e o mesmo `docker run`.

Exposto na rede, deixe `ALLOWED_HOSTS` restrito: o servidor só manda o login do Kibana para esses hosts.

## Uso

- **URL**: qualquer forma serve — `cliente.weon.com.br`, `https://cliente.weon.com.br/kibana` ou um link copiado de uma tela
  do Kibana. Sem caminho, tenta `/kibana`. As URLs usadas ficam na lista do campo.
- **Filtro** (campo `message`):
  - `a b` → E · `"frase exata"` · `-termo` / `-"frase"` → exclui
  - `a OR b` → OU (`OR` em maiúsculas; encadeia `a OR b OR c`; `x a OR b` = x E (a OU b))
  - `SEND_*`, `5541*`, `i0Gd?n0` → curinga dentro de uma palavra, sem diferenciar maiúsculas
    (não atravessa espaço/pontuação: para frase, use aspas)
- **Containers**: chips com a contagem do período; clique liga/desliga.
- **Ao vivo**: consulta o que chegou depois da última linha a cada 3 s.
- **Linha**: clique abre a mensagem inteira e o JSON em árvore (`[+]`/`[-]` por nível, abre até o 2º nível; texto que
  é JSON vira nó também; *Expandir/Recolher tudo*); *Ver ±30 s* mostra o que o container logou em volta.
  Duplo clique numa palavra (hashid, protocolo, telefone) adiciona ao filtro.
- A busca fica no `#` da URL da página — dá para favoritar.

Por padrão só escuta em `127.0.0.1` (`HOST` no `.env`); a senha fica no `.env` e nunca vai para o navegador.
