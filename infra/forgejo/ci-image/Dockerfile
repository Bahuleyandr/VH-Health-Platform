FROM ghcr.io/catthehacker/ubuntu:act-latest@sha256:f713414ec6c6f4c352c030005df8001c0c7d14154f3923e239d03daef2e9ae16

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    openjdk-17-jdk-headless \
    tar \
    unzip \
    xz-utils \
    zip \
  && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"
