/**
 * El proveedor soporta la opcion `exitOnReplaced`: ante `connectionReplaced` (440)
 * termina con codigo 79 en vez de reconectar. El host de bots verifica esta
 * constante al arrancar y se niega a correr si la version instalada no la exporta.
 */
export const SUPPORTS_EXIT_ON_REPLACED = true
