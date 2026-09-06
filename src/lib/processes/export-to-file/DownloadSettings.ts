import { SkeletonType } from '../../enums/SkeletonType.ts'

export enum BoneNamingStructure {
  Default = 'default',
  Mixamo = 'mixamo'
}

export enum ExportContents {
  Full = 'full',
  Skeleton = 'skeleton'
}

export enum ExportFormat {
  GLB = 'glb',
  FBX = 'fbx'
}

export enum FbxExportPreset {
  Unreal = 'unreal',
  // Blender = 'blender',
  // ThreeJS = 'threejs',
  Unity = 'unity',
  // Maya = 'maya'
}

export class DownloadSettings extends EventTarget {
  private static readonly storage_key = 'mesh2motion-export-settings'

  private selected_bone_naming_structure: BoneNamingStructure = this.get_default_bone_naming_structure()
  private selected_export_contents: ExportContents = this.get_default_export_contents()
  private selected_export_format: ExportFormat = this.get_default_export_format()
  private selected_fbx_export_preset: FbxExportPreset = this.get_default_fbx_export_preset()
  private dom_download_settings_popup: HTMLElement | null = null
  private dom_download_settings_toggle: HTMLButtonElement | null = null
  private dom_download_settings_panel: HTMLElement | null = null
  private dom_bone_naming_section: HTMLElement | null = null
  private dom_bone_naming_group: HTMLElement | null = null
  private dom_export_contents_group: HTMLElement | null = null
  private dom_export_format_group: HTMLElement | null = null
  private dom_fbx_preset_section: HTMLElement | null = null
  private dom_fbx_preset_group: HTMLElement | null = null

  constructor () {
    super()
    this.initialize_dom_elements()
    this.load_saved_settings()
    this.update_fbx_preset_ui_visibility()
    this.add_event_listeners()
  }

  private load_saved_settings (): void {
    try {
      const raw = localStorage.getItem(DownloadSettings.storage_key)
      if (raw === null) { return }
      const saved = JSON.parse(raw)
      if (this.is_bone_naming_structure(saved.bone_naming_structure)) {
        this.selected_bone_naming_structure = saved.bone_naming_structure
      }
      if (this.is_export_contents(saved.export_contents)) {
        this.selected_export_contents = saved.export_contents
      }
      if (this.is_export_format(saved.export_format)) {
        this.selected_export_format = saved.export_format
      }
      if (this.is_fbx_export_preset(saved.fbx_export_preset)) {
        this.selected_fbx_export_preset = saved.fbx_export_preset
      }
    } catch (error) {
      console.warn('Could not load saved export settings', error)
    }
  }

  private save_settings (): void {
    localStorage.setItem(DownloadSettings.storage_key, JSON.stringify({
      bone_naming_structure: this.selected_bone_naming_structure,
      export_contents: this.selected_export_contents,
      export_format: this.selected_export_format,
      fbx_export_preset: this.selected_fbx_export_preset
    }))
  }

  public bone_naming_structure (): BoneNamingStructure {
    return this.selected_bone_naming_structure
  }

  public export_contents (): ExportContents {
    return this.selected_export_contents
  }

  public export_format (): ExportFormat {
    return this.selected_export_format
  }

  public fbx_export_preset (): FbxExportPreset {
    return this.selected_fbx_export_preset
  }

  // The download settings popup is available for all skeleton types. The bone naming
  // options only apply to the human skeleton, so that section is shown/hidden here while
  // the export contents options remain available regardless of skeleton type.
  public update_download_settings_ui_visibility (skeleton_type: SkeletonType): void {
    // re-apply the user's saved settings (or the defaults) to the radio groups
    this.load_saved_settings()
    this.set_radio_group_value(this.dom_bone_naming_group, 'bone-naming-structure', this.selected_bone_naming_structure)
    this.set_radio_group_value(this.dom_export_contents_group, 'export-contents', this.selected_export_contents)
    this.set_radio_group_value(this.dom_export_format_group, 'export-format', this.selected_export_format)
    this.set_radio_group_value(this.dom_fbx_preset_group, 'fbx-export-preset', this.selected_fbx_export_preset)

    const is_human_skeleton = skeleton_type === SkeletonType.Human

    // Only the bone naming section is human-only; the popup itself is always available.
    if (this.dom_bone_naming_section !== null) {
      this.dom_bone_naming_section.style.display = is_human_skeleton ? '' : 'none'
    }

    this.update_fbx_preset_ui_visibility()
  }

  private initialize_dom_elements (): void {
    this.dom_download_settings_popup = document.querySelector('#download-settings-popup')
    this.dom_download_settings_toggle = document.querySelector('#download-settings-toggle')
    this.dom_download_settings_panel = document.querySelector('#download-settings')
    this.dom_bone_naming_section = document.querySelector('#download-bone-naming-section')
    this.dom_bone_naming_group = document.querySelector('#download-bone-naming-group')
    this.dom_export_contents_group = document.querySelector('#download-export-contents-group')
    this.dom_export_format_group = document.querySelector('#download-export-format-group')
    this.dom_fbx_preset_section = document.querySelector('#download-fbx-preset-section')
    this.dom_fbx_preset_group = document.querySelector('#download-fbx-preset-group')
  }

  private add_event_listeners (): void {
    this.dom_download_settings_toggle?.addEventListener('click', () => {
      this.set_popup_visibility(this.dom_download_settings_panel?.hidden !== false)
    })

    document.addEventListener('click', (event: MouseEvent) => {
      if (this.dom_download_settings_panel?.hidden !== false) {
        return
      }

      const clicked_element = event.target as Node | null
      if (clicked_element === null) {
        return
      }

      if (this.dom_download_settings_popup?.contains(clicked_element) !== true) {
        this.set_popup_visibility(false)
      }
    })

    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.set_popup_visibility(false)
      }
    })

    this.dom_bone_naming_group?.addEventListener('change', (event: Event) => {
      const selected_radio = event.target as HTMLInputElement | null

      if (selected_radio === null || selected_radio.name !== 'bone-naming-structure') {
        return
      }

      if (this.is_bone_naming_structure(selected_radio.value)) {
        this.selected_bone_naming_structure = selected_radio.value
      } else {
        this.selected_bone_naming_structure = this.get_default_bone_naming_structure()
      }

      this.save_settings()

      this.dispatchEvent(new CustomEvent('bone-naming-structure-changed', {
        detail: { boneNamingStructure: this.selected_bone_naming_structure }
      }))
    })

    this.dom_export_contents_group?.addEventListener('change', (event: Event) => {
      const selected_radio = event.target as HTMLInputElement | null

      if (selected_radio === null || selected_radio.name !== 'export-contents') {
        return
      }

      if (this.is_export_contents(selected_radio.value)) {
        this.selected_export_contents = selected_radio.value
      } else {
        this.selected_export_contents = this.get_default_export_contents()
      }

      this.save_settings()

      this.dispatchEvent(new CustomEvent('export-contents-changed', {
        detail: { exportContents: this.selected_export_contents }
      }))
    })

    this.dom_export_format_group?.addEventListener('change', (event: Event) => {
      const selected_radio = event.target as HTMLInputElement | null

      if (selected_radio === null || selected_radio.name !== 'export-format') {
        return
      }

      if (this.is_export_format(selected_radio.value)) {
        this.selected_export_format = selected_radio.value
      } else {
        this.selected_export_format = this.get_default_export_format()
      }

      this.save_settings()

      this.dispatchEvent(new CustomEvent('export-format-changed', {
        detail: { exportFormat: this.selected_export_format }
      }))

      this.update_fbx_preset_ui_visibility()
    })

    this.dom_fbx_preset_group?.addEventListener('change', (event: Event) => {
      const selected_radio = event.target as HTMLInputElement | null

      if (selected_radio === null || selected_radio.name !== 'fbx-export-preset') {
        return
      }

      if (this.is_fbx_export_preset(selected_radio.value)) {
        this.selected_fbx_export_preset = selected_radio.value
      } else {
        this.selected_fbx_export_preset = this.get_default_fbx_export_preset()
      }

      this.save_settings()

      this.dispatchEvent(new CustomEvent('fbx-export-preset-changed', {
        detail: { fbxExportPreset: this.selected_fbx_export_preset }
      }))
    })
  }

  private update_fbx_preset_ui_visibility (): void {
    if (this.dom_fbx_preset_section === null) {
      return
    }

    const should_show_fbx_preset = this.selected_export_format === ExportFormat.FBX
    this.dom_fbx_preset_section.hidden = !should_show_fbx_preset
  }

  private set_popup_visibility (is_visible: boolean): void {
    if (this.dom_download_settings_panel !== null) {
      this.dom_download_settings_panel.hidden = !is_visible
    }

    if (this.dom_download_settings_toggle !== null) {
      this.dom_download_settings_toggle.setAttribute('aria-expanded', is_visible ? 'true' : 'false')
    }
  }

  private set_radio_group_value (group: HTMLElement | null, name: string, value: string): void {
    const option_radio = group?.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)
    if (option_radio !== null && option_radio !== undefined) {
      option_radio.checked = true
    }
  }

  private is_bone_naming_structure (value: string): value is BoneNamingStructure {
    return Object.values(BoneNamingStructure).includes(value as BoneNamingStructure)
  }

  private is_export_contents (value: string): value is ExportContents {
    return Object.values(ExportContents).includes(value as ExportContents)
  }

  private is_export_format (value: string): value is ExportFormat {
    return Object.values(ExportFormat).includes(value as ExportFormat)
  }

  private is_fbx_export_preset (value: string): value is FbxExportPreset {
    return Object.values(FbxExportPreset).includes(value as FbxExportPreset)
  }

  private get_default_fbx_export_preset (): FbxExportPreset {
    return this.get_first_enum_value(FbxExportPreset)
  }

  private get_default_bone_naming_structure (): BoneNamingStructure {
    return this.get_first_enum_value(BoneNamingStructure)
  }

  private get_default_export_contents (): ExportContents {
    return this.get_first_enum_value(ExportContents)
  }

  private get_default_export_format (): ExportFormat {
    return this.get_first_enum_value(ExportFormat)
  }

  private get_first_enum_value<T extends string> (enum_object: Record<string, T>): T {
    const enum_values = Object.values(enum_object)
    if (enum_values.length === 0) {
      throw new Error('Enum has no values')
    }

    return enum_values[0]
  }
}
