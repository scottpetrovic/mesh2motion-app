import { UI } from './UI'
import { DOMUtilities } from './DOMUtilities'
import { type SceneEnvironmentManager } from './SceneEnvironmentManager'

export class SettingsDropdownManager {
  private static readonly storage_key = 'mesh2motion-scene-settings'

  private readonly ui: UI = UI.getInstance()
  private initialized: boolean = false
  private is_open: boolean = false
  private readonly scene_environment?: SceneEnvironmentManager

  constructor (scene_environment?: SceneEnvironmentManager) {
    this.scene_environment = scene_environment
    this.initialize()
  }

  private initialize (): void {
    if (this.initialized) {
      return
    }

    const toggle_button = this.ui.dom_settings_toggle_button
    const dropdown_container = this.ui.dom_settings_dropdown_container
    const dropdown_content = this.ui.dom_settings_dropdown_content

    if (toggle_button === null || dropdown_container === null || dropdown_content === null) {
      return
    }

    this.initialized = true

    toggle_button.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      this.toggle_dropdown()
    })

    document.addEventListener('click', (event: MouseEvent) => {
      if (!this.is_open) {
        return
      }

      const target = event.target as Node | null
      if (target === null) {
        return
      }

      if (!dropdown_container.contains(target)) {
        this.close_dropdown()
      }
    })

    document.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.close_dropdown()
      }
    })

    this.initialize_light_intensity_setting()
    this.initialize_turntable_speed_setting()
    this.initialize_floor_grid_setting()
    this.initialize_background_setting()
    this.load_saved_settings()
  }

  private load_saved_settings (): void {
    try {
      const raw = localStorage.getItem(SettingsDropdownManager.storage_key)
      if (raw === null) { return }
      const saved = JSON.parse(raw)

      if (typeof saved.light_intensity === 'number') {
        this.scene_environment?.set_light_intensity_multiplier(saved.light_intensity)
        if (this.ui.dom_light_intensity_input !== null) {
          this.ui.dom_light_intensity_input.value = saved.light_intensity.toFixed(2)
        }
      }
      if (typeof saved.turntable_speed === 'number') {
        this.scene_environment?.set_turntable_speed(saved.turntable_speed)
        if (this.ui.dom_turntable_speed_input !== null) {
          this.ui.dom_turntable_speed_input.value = saved.turntable_speed.toFixed(1)
        }
      }
      if (typeof saved.floor_grid === 'boolean') {
        this.scene_environment?.set_floor_grid_visible(saved.floor_grid)
        if (this.ui.dom_floor_grid_toggle !== null) {
          this.ui.dom_floor_grid_toggle.checked = saved.floor_grid
        }
      }
      if (typeof saved.solid_background === 'boolean') {
        if (this.ui.dom_solid_background_toggle !== null) {
          this.ui.dom_solid_background_toggle.checked = saved.solid_background
        }
        this.apply_solid_background(saved.solid_background)
      }
    } catch (error) {
      console.warn('Could not load saved scene settings', error)
    }
  }

  private save_settings (): void {
    localStorage.setItem(SettingsDropdownManager.storage_key, JSON.stringify({
      light_intensity: this.scene_environment?.get_light_intensity_multiplier() ?? 1.0,
      turntable_speed: this.scene_environment?.get_turntable_speed() ?? 0,
      floor_grid: this.ui.dom_floor_grid_toggle?.checked ?? true,
      solid_background: this.ui.dom_solid_background_toggle?.checked ?? false
    }))
  }

  private initialize_floor_grid_setting (): void {
    if (this.scene_environment === undefined) {
      return
    }

    const floor_grid_toggle = this.ui.dom_floor_grid_toggle
    if (floor_grid_toggle === null) {
      return
    }

    floor_grid_toggle.addEventListener('change', () => {
      this.scene_environment?.set_floor_grid_visible(floor_grid_toggle.checked)
      this.save_settings()
    })
  }

  private initialize_background_setting (): void {
    const solid_background_toggle = this.ui.dom_solid_background_toggle
    if (solid_background_toggle === null) {
      return
    }

    // keep the checkbox and body class in sync with the configured default on startup
    solid_background_toggle.checked = DOMUtilities.settings_defaults.solid_background_enabled
    this.apply_solid_background(solid_background_toggle.checked)

    solid_background_toggle.addEventListener('change', () => {
      this.apply_solid_background(solid_background_toggle.checked)
      this.save_settings()
    })
  }

  private apply_solid_background (is_enabled: boolean): void {
    document.body.classList.toggle('solid-background', is_enabled)
  }

  private initialize_light_intensity_setting (): void {
    if (this.scene_environment === undefined) {
      return
    }

    const light_intensity_input = this.ui.dom_light_intensity_input
    if (light_intensity_input === null) {
      return
    }

    light_intensity_input.value = this.scene_environment.get_light_intensity_multiplier().toFixed(2)

    light_intensity_input.addEventListener('input', () => {
      const slider_value = Number(light_intensity_input.value)
      if (!Number.isFinite(slider_value)) {
        return
      }

      this.scene_environment?.set_light_intensity_multiplier(slider_value)
      this.save_settings()
    })
  }

  private initialize_turntable_speed_setting (): void {
    if (this.scene_environment === undefined) {
      return
    }

    const turntable_speed_input = this.ui.dom_turntable_speed_input
    if (turntable_speed_input === null) {
      return
    }

    turntable_speed_input.value = this.scene_environment.get_turntable_speed().toFixed(1)

    turntable_speed_input.addEventListener('input', () => {
      const slider_value = Number(turntable_speed_input.value)
      if (!Number.isFinite(slider_value)) {
        return
      }

      this.scene_environment?.set_turntable_speed(slider_value)
      this.save_settings()
    })
  }

  private open_dropdown (): void {
    const toggle_button = this.ui.dom_settings_toggle_button
    const dropdown_content = this.ui.dom_settings_dropdown_content

    if (toggle_button === null || dropdown_content === null) {
      return
    }

    this.is_open = true
    dropdown_content.hidden = false
    toggle_button.setAttribute('aria-expanded', 'true')
  }

  private close_dropdown (): void {
    const toggle_button = this.ui.dom_settings_toggle_button
    const dropdown_content = this.ui.dom_settings_dropdown_content

    if (toggle_button === null || dropdown_content === null) {
      return
    }

    this.is_open = false
    dropdown_content.hidden = true
    toggle_button.setAttribute('aria-expanded', 'false')
  }

  private toggle_dropdown (): void {
    if (this.is_open) {
      this.close_dropdown()
    } else {
      this.open_dropdown()
    }
  }
}