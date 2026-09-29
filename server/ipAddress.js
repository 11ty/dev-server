import os from "node:os";

const INTERFACE_FAMILIES = ["IPv4"];

export default function() {
    return Object.values(os.networkInterfaces()).flatMap(list => list ?? []).filter(({family, internal}) => {
        return internal === false && INTERFACE_FAMILIES.includes(family);
    }).map(({ address }) => address);
};