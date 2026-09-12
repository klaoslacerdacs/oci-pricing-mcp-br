FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# CACHEBUST invalida o clone+refresh a cada deploy sem refazer a camada apt.
# O cron do host passa --build-arg CACHEBUST=$(date +%s).
ARG CACHEBUST=0
RUN git clone --depth 1 https://github.com/klaoslacerdacs/oci-pricing-mcp-br.git . && npm ci
# Puxa preço vivo da Oracle no build. Falha duro se a API cair (não corrompe:
# generate-data recusa sobrescrever com resposta vazia), e o container antigo
# segue no ar porque `up -d --build` só troca se o build passar.
RUN npm run generate-data && npm run build
RUN npm install -g supergateway
EXPOSE 8080
CMD supergateway --stdio "node dist/index.js" --outputTransport streamableHttp --port 8080 --streamableHttpPath /mcp --stateful --healthEndpoint /healthz
