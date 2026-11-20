# Paquete .rpm de Pulso Editor para Fedora, compilado dentro de un contenedor Fedora.
# Se construye desde la raíz del repositorio (ver packaging/linux/build-rpm.ps1):
#   docker build -f packaging/linux/Dockerfile --target out --output type=local,dest=dist-linux .
FROM fedora:42 AS build

# Dependencias de Tauri 2 en Fedora, más rpm-build para generar el .rpm y dbus-devel para el llavero (keyring).
RUN dnf install -y --setopt=install_weak_deps=False \
      @development-tools gcc gcc-c++ make pkgconf-pkg-config \
      webkit2gtk4.1-devel gtk3-devel libsoup3-devel javascriptcoregtk4.1-devel \
      openssl-devel dbus-devel libappindicator-gtk3-devel librsvg2-devel libxdo-devel \
      rpm-build file curl wget nodejs npm \
 && dnf clean all

RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /src
# Primero solo lo que define las dependencias, para que Docker reutilice esta capa entre compilaciones.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

COPY . .
RUN npm run tauri build -- --bundles rpm

# Solo el paquete, para sacarlo con `--output`.
FROM scratch AS out
COPY --from=build /src/src-tauri/target/release/bundle/rpm/*.rpm /
