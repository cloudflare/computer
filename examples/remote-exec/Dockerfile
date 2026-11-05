# Docker's agent-less sandbox image (https://docs.docker.com/ai/sandboxes/agents/shell/). Its own
# CMD is an interactive bash, which exits straight away without a terminal; sleep under its tini
# instead. remote-exec isn't baked in: the Worker copies its bundled build in on first use.
# IMAGE_ENV is for the tests: commands get the image's environment.
FROM docker/sandbox-templates:shell
ENV IMAGE_ENV=from-the-image
CMD ["sleep", "infinity"]
