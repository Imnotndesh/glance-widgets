#!/usr/bin/env bash

set -euo pipefail

REPO="${GLANCE_REPO:-Imnotndesh/glance-widgets}"
UUID="glance-widgets@imnotndesh.github"
EXTENSIONS_DIR="${GLANCE_EXTENSIONS_DIR:-${HOME}/.local/share/gnome-shell/extensions}"
TARGET_DIR="${EXTENSIONS_DIR}/${UUID}"
GITHUB_API="https://api.github.com/repos/${REPO}"
GITHUB_RAW="https://raw.githubusercontent.com/${REPO}"


RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }
header(){ echo -e "\n${BOLD}── $1 ──${NC}\n"; }

show_help() {
    sed -n '/^#/p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

check_prereqs() {
    local missing=()
    for cmd in curl tar; do
        if ! command -v "$cmd" &>/dev/null; then
            missing+=("$cmd")
        fi
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        error "Missing required tools: ${missing[*]}"
        echo "  Install them with your package manager, e.g.:"
        echo "    sudo apt install ${missing[*]}    (Debian/Ubuntu)"
        echo "    sudo dnf install ${missing[*]}    (Fedora)"
        echo "    brew install ${missing[*]}        (macOS)"
        exit 1
    fi
}

fetch_latest_release() {
    curl -sSfL "${GITHUB_API}/releases/latest" 2>/dev/null || {
        error "Failed to fetch latest release from GitHub API."
        echo "  Check your internet connection or if the repo '${REPO}' exists."
        exit 1
    }
}

parse_json() {
    local json="$1"
    local key="$2"
    echo "$json" | sed -n 's/.*"'"$key"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}



version_less_than() {
    local v1="$1" v2="$2"
    if [[ "$v1" == "$v2" ]]; then
        return 1
    fi
    local IFS=.
    local i ver1=($v1) ver2=($v2)
    for ((i = 0; i < ${#ver1[@]} || i < ${#ver2[@]}; i++)); do
        local n1="${ver1[i]:-0}"
        local n2="${ver2[i]:-0}"
        if ((10#${n1} < 10#${n2})); then
            return 0
        elif ((10#${n1} > 10#${n2})); then
            return 1
        fi
    done
    return 1
}

get_installed_version() {
    local meta="${TARGET_DIR}/metadata.json"
    if [[ -f "$meta" ]]; then
        grep -o '"version-name"[[:space:]]*:[[:space:]]*"[^"]*"' "$meta" \
            | sed 's/.*"version-name"[[:space:]]*:[[:space:]]*"\(.*\)"/\1/'
    fi
}

do_install() {
    header "Glance Widgets — Installing"

    local release_json
    release_json="$(fetch_latest_release)"

    local tag_name
    tag_name="$(parse_json "$release_json" ".tag_name")" || true
    local version
    version="$(parse_json "$release_json" ".tag_name" | sed 's/^v//')" || version="latest"

    if [[ -z "$tag_name" ]]; then
        warn "Could not determine latest tag; using 'main' branch."
        tag_name="main"
        version="main"
    fi

    info "Latest release: ${tag_name} (version ${version})"

    local archive_url="${GITHUB_API}/tarball/${tag_name}"
    local tmpdir
    tmpdir="$(mktemp -d)"
    local archive="${tmpdir}/glance.tar.gz"

    echo "  Downloading ${archive_url} …"
    curl -sSfL -o "$archive" "$archive_url" 2>/dev/null || {
        error "Download failed."
        rm -rf "$tmpdir"
        exit 1
    }

    mkdir -p "${EXTENSIONS_DIR}"
    if [[ -d "$TARGET_DIR" ]]; then
        warn "Removing previous installation at ${TARGET_DIR}"
        rm -rf "$TARGET_DIR"
    fi

    mkdir -p "$TARGET_DIR"

    tar -xzf "$archive" -C "$tmpdir" --strip-components=1

    if [[ -d "${tmpdir}/${UUID}" ]]; then
        cp -r "${tmpdir}/${UUID}/"* "$TARGET_DIR/"
    else
        cp -r "${tmpdir}/"* "$TARGET_DIR/"
    fi

    rm -rf "$tmpdir"

    info "Installed to ${TARGET_DIR}"

    if [[ ! -f "${TARGET_DIR}/metadata.json" ]]; then
        error "Installation appears incomplete — metadata.json not found."
        exit 1
    fi

    local installed_ver
    installed_ver="$(get_installed_version)" || installed_ver="?"
    info "Installed version: ${installed_ver}"

    echo ""
    echo -e "  ${YELLOW}→ Restart GNOME Shell to load the extension:${NC}"
    echo -e "    ${BOLD}Alt+F2${NC}, type ${BOLD}r${NC}, press ${BOLD}Enter${NC} (X11)"
    echo -e "    or log out and back in (Wayland)"
    echo ""
    echo -e "  Then enable it with:"
    echo -e "    ${BOLD}gnome-extensions enable ${UUID}${NC}"
}



do_update() {
    header "Glance Widgets — Checking for Updates"

    if [[ ! -d "$TARGET_DIR" ]]; then
        warn "Glance Widgets is not installed yet. Run with --install first."
        exit 1
    fi

    local current
    current="$(get_installed_version)" || {
        error "Could not read installed version from ${TARGET_DIR}/metadata.json"
        exit 1
    }
    info "Installed version: ${current}"

    local release_json
    release_json="$(fetch_latest_release)"
    local tag_name
    tag_name="$(parse_json "$release_json" ".tag_name")" || tag_name=""
    local latest
    latest="$(echo "$tag_name" | sed 's/^v//')"
    if [[ -z "$latest" ]]; then
        latest="$(parse_json "$release_json" ".tag_name")"
    fi
    if [[ -z "$latest" ]]; then
        error "Could not determine latest release version."
        exit 1
    fi

    info "Latest release:  ${latest}"

    if version_less_than "$current" "$latest"; then
        echo ""
        info "New version available: ${current} → ${latest}"
        echo "  Updating …"
        do_install
        info "Update complete!"
    else
        info "You are already on the latest version (${current})."
    fi
}

do_check() {
    header "Glance Widgets — Version Check"

    if [[ ! -d "$TARGET_DIR" ]]; then
        warn "Glance Widgets is not installed."
        exit 0
    fi

    local current
    current="$(get_installed_version)" || current="unknown"
    echo "  Installed:  ${current}"

    local release_json
    release_json="$(fetch_latest_release)" || {
        echo "  Latest:     (could not fetch)"
        exit 1
    }
    local tag_name
    tag_name="$(parse_json "$release_json" ".tag_name")" || tag_name=""
    local latest
    latest="$(echo "$tag_name" | sed 's/^v//')"
    [[ -z "$latest" ]] && latest="${tag_name}"
    echo "  Latest:     ${latest:-unknown}"

    if [[ -n "$current" && -n "$latest" ]]; then
        if version_less_than "$current" "$latest"; then
            echo -e "  ${YELLOW}→ Update available! Run with --update${NC}"
        else
            info "Up to date."
        fi
    fi
}

main() {
    check_prereqs

    case "${1:-}" in
        --install|-i)
            do_install
            ;;
        --update|-u)
            do_update
            ;;
        --check|-c)
            do_check
            ;;
        --help|-h|*)
            show_help
            ;;
    esac
}

main "$@"
