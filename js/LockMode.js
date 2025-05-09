import { app } from "../../scripts/app.js";
import { getStorageValue, setStorageValue } from "../../scripts/utils.js";

const hiddenLinkMode = -1;
const slotOffset = 5;

const nodeOptionsWhitelist = [
    "Open Image",
    "Save Image",
    "Copy Image",
    "Open in MaskEditor"
];

const classDisplayDisabledBlacklist = [
    "Note",
    "MarkdownNote"
];

const classLockedDisableBlacklist = [
    "PrimitiveNode"
];

const classLockedEnableBlacklist = [
    "Reroute",
    "Reroute (rgthree)"
];

const nodeDefaultAllowInteractionValue = true;

const pageCss = `
.disabled {
	pointer-events: none !important;
    cursor: not-allowed !important;
}

.disabled a {
	pointer-events: auto !important;
}

.display_disabled {
    opacity: 0.5 !important;
}

.display_enabled {
    opacity: 1 !important;
}
`;

function updateNodesWidgetsDisabledState(disabled) {
    const nodes = app.graph.nodes;
    nodes.forEach((node) => {
        const force_allow_interaction = (classLockedDisableBlacklist.indexOf(node.type) > -1);
        const allow_interaction = force_allow_interaction || (node.flags.allow_interaction ?? false);
        const widget_disabled = disabled && !allow_interaction;
        const display_as_disabled = widget_disabled && !(classDisplayDisabledBlacklist.indexOf(node.type) > -1);
        const widgets = node.widgets ?? [];
        widgets.forEach((widget) => {
            widget.disabled = widget_disabled;

            if (widget.classList) {
                if (display_as_disabled) {
                    widget.classList.remove('display_enabled');
                } else {
                    widget.classList.add('display_enabled');
                }
            }

            if (widget.element) {
                widget.element.disabled = widget_disabled;

                if (widget.element.classList) {
                    if (widget_disabled) {
                        widget.element.classList.add('disabled');
                    } else {
                        widget.element.classList.remove('disabled');
                    }

                    if (display_as_disabled) {
                        widget.element.classList.add('display_disabled');
                    } else {
                        widget.element.classList.remove('display_disabled');
                    }
                }
            }
        });
    });
}

function updateSelectionOverlayDisabledState(disabled) {
    const overlays = document.querySelectorAll(".selection-overlay-container,.selection-toolbox");
    [].forEach.call(overlays, (element) => {
        if (disabled) {
            element.classList.add('hidden');
        } else {
            element.classList.remove('hidden');
        }
    });
}

function updateNodesLinksDisabledState(disabled) {
    const linkRenderMode = app.extensionManager.setting.get("Comfy.LinkRenderMode");
    const linkHiddenState = (linkRenderMode === hiddenLinkMode);

    // Set node links visibility state
    if (disabled !== linkHiddenState) {
        app.extensionManager.command.execute("Comfy.Canvas.ToggleLinkVisibility");
    }
}

function getSelectedNodes() {
    const selectedNodes = app.canvas.selected_nodes;
    const result = [];
    if (selectedNodes) {
        for (const i in selectedNodes) {
            const node = selectedNodes[i];
            result.push(node);
        }
    }
    return result;
}

function setSelectedNodesInteractionState(value) {
    getSelectedNodes().forEach((node) => {
        node.flags.allow_interaction = value;
    })
}

app.registerExtension({
    name: "Comfy.LockMode",

    init() {
        if (getStorageValue("LockMode.Enabled") == null) {
            setStorageValue("LockMode.Enabled", true);
        }

		const $style = document.createElement("style");
		$style.innerHTML = pageCss;
		document.head.appendChild($style);
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        // Add allow/deny in locked mode switch
        const original_getExtraMenuOptions = nodeType.prototype.getExtraMenuOptions;
        nodeType.prototype.getExtraMenuOptions = function(_, options) {
            original_getExtraMenuOptions?.apply(this, arguments);
            options.push({
                content: this.flags.allow_interaction ? "Deny in locked mode" : "Allow in locked mode",
                callback: async () => {
                    const mode = !this.flags.allow_interaction;
                    for (const item of app.canvas.selectedItems) {
                      if (item instanceof LGraphNode) item.flags.allow_interaction = mode;
                    }
                    app.graph.change();
                }
            })
        }
    },

    beforeConfigureGraph(graphData, missingNodeTypes) {
        // Allow node creation on entire graph loading
        app.graph._loading = true;
    },

    afterConfigureGraph() {
        // And deny after it, if we are in locked mode
        app.graph._loading = false;

        // Lock UI widgets, especially multiline text
        const isLockModeEnabled = (getStorageValue("LockMode.Enabled") === "true");
        updateNodesWidgetsDisabledState(isLockModeEnabled);
        updateSelectionOverlayDisabledState(isLockModeEnabled);
        updateNodesLinksDisabledState(isLockModeEnabled);

        // Reset view after graph load
        app.resetView();
    },

    nodeCreated(node) {
        // Add default allow_interaction value
        node.flags.allow_interaction = nodeDefaultAllowInteractionValue;

        // Add lock icon to node title
        const original_getTitle = node.getTitle;
        node.getTitle = function() {
            const locked = !this.flags.allow_interaction;
            return original_getTitle.call(this) + (locked ? "🔒" : "");
        }
    },

    commands: [
        {
            id: 'lockMode.selection.unlock',
            label: 'Allow in locked mode',
            icon: 'pi pi-lock-open',
            function: () => {
                setSelectedNodesInteractionState(true);
                app.canvas.deselectAllNodes();
            }
        },
        {
            id: 'lockMode.selection.lock',
            label: 'Deny in locked mode',
            icon: 'pi pi-lock',
            function: () => {
                setSelectedNodesInteractionState(false);
                app.canvas.deselectAllNodes();
            }
        }
    ],
    
    getSelectionToolboxCommands: (selectedItem) => {
        if (selectedItem.flags.allow_interaction) {
            return ['lockMode.selection.lock'];
        } else {
            return ['lockMode.selection.unlock'];
        }
    },

    async setup() {
        let lockButton;
        let unlockButton;

        let canvasPasteFromClipboard = app.canvas._pasteFromClipboard;
        let canvasShowLinkMenu = app.canvas.showLinkMenu;
        let canvasGetNodeMenuOptions = app.canvas.getNodeMenuOptions;
        let canvasDeleteSelected = app.canvas.deleteSelected;

        let graphAdd = app.graph.add;
        let graphClear = app.graph.clear;

        function canvasOnMouse(e2) {
            const { pointer, graph } = this;
            const x2 = e2.canvasX;
            const y2 = e2.canvasY;

            // Allow dragging canvas
            pointer.finally = () => this.dragging_canvas = false
            this.dragging_canvas = true

            // Stop double clicks
            pointer.eLastDown = void 0;

            // Stop mouse interaction with ctrl/meta keys
            const ctrlOrMeta = e2.ctrlKey || e2.metaKey;
            if (ctrlOrMeta) {
                return true;
            }

            // Stop mouse interaction with alt key
            if (e2.altKey) {
                return true;
            }

            // Stop mouse interaction with shift key
            if (e2.shiftKey) {
                return true;
            }

            const node = graph.getNodeOnPos(x2, y2, this.visible_nodes);

            if (node) {
                // Stop interaction with collapsed nodes
                if (node.flags.collapsed) {
                    return true;
                }

                // Do not block interaction with this nodes
                if (!(classLockedDisableBlacklist.indexOf(node.type) > -1)) {
                    // Stop interaction with disabled nodes
                    if (!node.flags.allow_interaction) {
                        return true;
                    }

                    // Stop interaction with blacklisted nodes
                    if ((classLockedEnableBlacklist.indexOf(node.type) > -1)) {
                        return true;
                    }
                }

                // Stop interaction with node resize corner
                if (node.resizable !== false && node.inResizeCorner(x2, y2)) {
                    return true;
                }

                // Stop interaction with node name and collapse button
                const posY = y2 - node.pos[1];
                if (posY < 0) {
                    return true;
                }

                // Stop interaction with node links (slots)
                const slot = node.getSlotOnPos([x2, y2]);
                if (slot) {
                    const minX = node.pos[0] + slot.boundingRect[0];
                    const maxX = minX + slot.boundingRect[2];
                    if (x2 >= (minX - slotOffset) && x2 <= (maxX + slotOffset)) {
                        return true;
                    }
                }

            } else {
                // Stop interaction with groups outside the nodes
                const group = graph.getGroupOnPos(x2, y2);
                if (group) {
                    return true;
                }

                // Stop right clicks outside the nodes
                if (e2.button === 2) {
                    return true;
                }
            }

            // Pass all other clicks
            return false;
        }

        function canvasGetNodeMenuOptionsLocked(node) {
            let options = [];

            // Get only extra menu options
            const extra = node.getExtraMenuOptions?.(this, options);
            if (Array.isArray(extra) && extra.length > 0) {
                extra.push(null);
                options = extra.concat(options);
            }

            // And filter it with whitelist
            options = options.filter(option => option && (nodeOptionsWhitelist.indexOf(option.content) > -1));

            // Return only if not empty
            if (options.length > 0) {
                return options;
            }

            return null;
        }

        function graphAddLocked(obj) {
            // Only allow adding if in initial loading state
            if (this._loading) {
                return graphAdd.call(this, obj);
            }
            return null;
        }

        function graphClearLocked() {
            // Only allow adding if in initial loading state
            if (this._loading) {
                return graphClear.call(this);
            }
            return null;
        }

        function setLockMode(mode) {
            const isLockModeEnabled = (getStorageValue("LockMode.Enabled") === "true");
            if (mode != isLockModeEnabled) {
                try {
                    setStorageValue("LockMode.Enabled", mode)
                    updateButtons();
                    updateMode();
                    updateWidgets();
                    updateSelectionOverlay();
                    updateNodeLinks();
                } catch(exception) {
                    console.log('Unexpected error when switching modes.');
                }
            }
        }

        function updateButtons() {
            const isLockModeEnabled = (getStorageValue("LockMode.Enabled") === "true");

            // Set buttons style
            if (isLockModeEnabled) {
                lockButton.classList.add("primary");
                unlockButton.classList.remove("primary");
            } else {
                lockButton.classList.remove("primary");
                unlockButton.classList.add("primary");
            }
        }

        function updateMode() {
            const isLockModeEnabled = (getStorageValue("LockMode.Enabled") === "true");

            if (isLockModeEnabled) {
                app.canvas.allow_dragnodes = false;
                app.canvas.allow_reconnect_links = false;
                app.canvas.onMouse = canvasOnMouse;
                app.canvas._pasteFromClipboard = () => {};
                app.canvas.showLinkMenu = () => {};
                app.canvas.getNodeMenuOptions = canvasGetNodeMenuOptionsLocked;
                app.canvas.deleteSelected = () => {};
                app.graph.add = graphAddLocked;
                app.graph.clear = graphClearLocked;
            } else {
                app.canvas.allow_dragnodes = true;
                app.canvas.allow_reconnect_links = true;
                app.canvas.onMouse = null;
                app.canvas._pasteFromClipboard = canvasPasteFromClipboard;
                app.canvas.showLinkMenu = canvasShowLinkMenu;
                app.canvas.getNodeMenuOptions = canvasGetNodeMenuOptions;
                app.canvas.deleteSelected = canvasDeleteSelected;
                app.graph.add = graphAdd;
                app.graph.clear = graphClear;
            }
        }

        function updateWidgets() {
            const isLockModeEnabled = (getStorageValue("LockMode.Enabled") === "true");

            // Set widgets disabled state
            updateNodesWidgetsDisabledState(isLockModeEnabled);
        }

        function updateSelectionOverlay() {
            const isLockModeEnabled = (getStorageValue("LockMode.Enabled") === "true");

            // Set selection overlay disabled state
            updateSelectionOverlayDisabledState(isLockModeEnabled);
        }

        function updateNodeLinks() {
            const isLockModeEnabled = (getStorageValue("LockMode.Enabled") === "true");

            // Set node links visibility state
            updateNodesLinksDisabledState(isLockModeEnabled);
        }

        try {
            // new style Manager buttons
            // unload models button into new style Manager button

            lockButton = new(await import("/scripts/ui/components/button.js")).ComfyButton({
                icon: "lock",
                action: () => {
                    setLockMode(true);
                },
                tooltip: "Lock nodes",
                classList: "comfyui-button comfyui-menu-mobile-collapse"
            }).element

            unlockButton = new(await import("/scripts/ui/components/button.js")).ComfyButton({
                icon: "lock-open-variant",
                action: () => {
                    setLockMode(false);
                },
                tooltip: "Unlock nodes",
                classList: "comfyui-button comfyui-menu-mobile-collapse"
            }).element

            let cmGroup = new (await import("/scripts/ui/components/buttonGroup.js")).ComfyButtonGroup(
                lockButton, unlockButton
            );

            app.menu?.settingsGroup.element.before(cmGroup.element);

            updateButtons();
            updateMode();

        } catch(exception) {
            console.log('ComfyUI is outdated. New style menu based features are disabled.');
        }
    },
});